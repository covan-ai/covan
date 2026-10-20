import { describe, it, expect, vi } from "vitest";
import { googleDriveProvider, importableName, listFolders, folderIdOf } from "./google-drive";
import { FileSkip, type ProviderContext } from "./types";
import { tinyPdf } from "../../test-support/tiny-pdf";
import { makeZip } from "../../test-support/make-zip";

const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" };

const ctx = (fetchImpl: typeof fetch, config: Record<string, unknown> = {}): ProviderContext => ({
  token: { accessToken: "ya29.token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 },
  config,
  fetchImpl,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("what Drive can import", () => {
  it("renames a Google-native file to match what the export produces", () => {
    expect(
      importableName({
        id: "1",
        name: "Handbook",
        mimeType: "application/vnd.google-apps.document",
      }),
    ).toBe("Handbook.md");
    expect(
      importableName({
        id: "2",
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
      }),
    ).toBe("Budget.xlsx");
  });

  it("leaves an already-correct extension alone", () => {
    expect(
      importableName({
        id: "3",
        name: "notes.md",
        mimeType: "application/vnd.google-apps.document",
      }),
    ).toBe("notes.md");
  });

  it("keeps ordinary text files under their own name", () => {
    expect(importableName({ id: "4", name: "data.csv", mimeType: "text/csv" })).toBe("data.csv");
  });

  // Read on the server now (`lib/formats/read/pdf.ts`), and by Claude when
  // there is no text layer.
  it("imports a PDF under its own name", () => {
    expect(importableName({ id: "5", name: "contract.pdf", mimeType: "application/pdf" })).toBe(
      "contract.pdf",
    );
  });

  // Drive types code and logs as `text/*`, and a few text formats as
  // `application/*`; all of them are prose to a reader.
  it("reads any text type as text", () => {
    expect(importableName({ id: "5a", name: "sync.py", mimeType: "text/x-python" })).toBe(
      "sync.py",
    );
    expect(importableName({ id: "5b", name: "deploy.yaml", mimeType: "application/x-yaml" })).toBe(
      "deploy.yaml",
    );
  });

  // Skipped without a word until the server could read them.
  it("imports Office files under their own extension", () => {
    expect(
      importableName({
        id: "6",
        name: "deck",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toBe("deck.pptx");
    expect(
      importableName({
        id: "7",
        name: "Budget.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("Budget.xlsx");
  });
});

describe("google drive provider", () => {
  it("is off until the deployment registers a client", () => {
    expect(googleDriveProvider.isConfigured({})).toBe(false);
    expect(googleDriveProvider.isConfigured(env)).toBe(true);
  });

  // Without both of these Google issues no refresh token for somebody who has
  // granted the app before, and the connection works for exactly one hour.
  it("asks for offline access and a fresh consent", () => {
    const url = new URL(
      googleDriveProvider.authorizeUrl(env, "state", "https://api.example.com/cb"),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
  });

  it("stores the refresh token and labels the connection with the account", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      }
      return json({ user: { emailAddress: "deniz@covan.app", displayName: "Deniz" } });
    }) as unknown as typeof fetch;

    const result = await googleDriveProvider.exchangeCode(
      env,
      "code",
      "https://api.example.com/cb",
      fetchImpl,
    );

    expect(result.token.accessToken).toBe("at");
    expect(result.token.refreshToken).toBe("rt");
    expect(result.accountLabel).toBe("deniz@covan.app");
    // No folder yet — that is the second step, and until it happens the
    // connection is created paused.
    expect(result.config).toEqual({});
  });

  it("refuses a grant with no refresh token rather than storing an hour of access", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ access_token: "at", expires_in: 3600 }),
    ) as unknown as typeof fetch;

    await expect(
      googleDriveProvider.exchangeCode(env, "code", "https://api.example.com/cb", fetchImpl),
    ).rejects.toThrow(/refresh token/i);
  });

  it("carries the refresh token forward, since Google does not re-issue it", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ access_token: "new-at", expires_in: 3600 }),
    ) as unknown as typeof fetch;

    const refreshed = await googleDriveProvider.refresh(
      env,
      { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() },
      fetchImpl,
    );

    expect(refreshed.accessToken).toBe("new-at");
    // Dropping it here would turn every refresh into the last one.
    expect(refreshed.refreshToken).toBe("rt");
  });

  it("does not spend a request on a token that is still good", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };

    expect(await googleDriveProvider.refresh(env, token, fetchImpl)).toBe(token);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to list anything until a folder has been chosen", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(googleDriveProvider.listFiles(ctx(fetchImpl))).rejects.toThrow(/no folder/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(folderIdOf({})).toBeNull();
    expect(folderIdOf({ folderId: "abc" })).toBe("abc");
  });

  it("walks into subfolders and drops what it cannot read", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("'root-folder'")) {
        return json({
          files: [
            {
              id: "doc-1",
              name: "Handbook",
              mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-09-01T10:00:00Z",
              webViewLink: "https://docs.google.com/doc-1",
            },
            { id: "photo", name: "team.jpg", mimeType: "image/jpeg" },
            { id: "sub", name: "Policies", mimeType: "application/vnd.google-apps.folder" },
          ],
        });
      }
      return json({
        files: [
          {
            id: "doc-2",
            name: "Leave.md",
            mimeType: "text/markdown",
            modifiedTime: "2026-08-01T10:00:00Z",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const files = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root-folder" }));

    // The photo is listed so the run can say why it was not imported.
    expect(files.filter((f) => !f.skipReason).map((f) => f.externalId)).toEqual(["doc-1", "doc-2"]);
    expect(files.find((f) => f.externalId === "photo")?.skipReason).toMatch(/an image/);
    expect(files[0]).toMatchObject({
      name: "Handbook.md",
      version: "2026-09-01T10:00:00Z",
      url: "https://docs.google.com/doc-1",
    });
  });

  // "Add shortcut to Drive" is how somebody puts a document from a shared drive
  // into the folder they work in. Every one of these used to be skipped without
  // a word, so a folder of shortcuts synced as an empty bundle.
  it("follows a shortcut to the file it points at", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files/doc-1")) {
        return json({
          id: "doc-1",
          name: "Handbook",
          mimeType: "application/vnd.google-apps.document",
          // The target's modified time, not the shortcut's. The shortcut never
          // changes when the document is edited, so using its own would mean an
          // edited document never re-imported.
          modifiedTime: "2026-09-02T10:00:00Z",
          webViewLink: "https://docs.google.com/doc-1",
        });
      }
      return json({
        files: [
          {
            id: "short-1",
            name: "Handbook shortcut",
            mimeType: "application/vnd.google-apps.shortcut",
            modifiedTime: "2026-01-01T00:00:00Z",
            shortcutDetails: {
              targetId: "doc-1",
              targetMimeType: "application/vnd.google-apps.document",
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const files = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root" }));

    expect(files).toEqual([
      {
        externalId: "doc-1",
        name: "Handbook.md",
        version: "2026-09-02T10:00:00Z",
        url: "https://docs.google.com/doc-1",
      },
    ]);
  });

  it("walks into a shortcut to a folder without spending a request on it", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("'root'")) {
        return json({
          files: [
            {
              id: "short-f",
              name: "Policies shortcut",
              mimeType: "application/vnd.google-apps.shortcut",
              shortcutDetails: {
                targetId: "sub",
                targetMimeType: "application/vnd.google-apps.folder",
              },
            },
          ],
        });
      }
      return json({
        files: [
          { id: "doc-2", name: "Leave.md", mimeType: "text/markdown", modifiedTime: "2026-08-01" },
        ],
      });
    }) as unknown as typeof fetch;

    const files = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root" }));

    expect(files.map((f) => f.externalId)).toEqual(["doc-2"]);
    // Two listings and no metadata read: a folder shortcut carries the only
    // thing the walk wants, which is an id.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("imports one document when the folder holds both a file and a shortcut to it", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        files: [
          {
            id: "doc-1",
            name: "Handbook",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-09-01T10:00:00Z",
          },
          {
            id: "short-1",
            name: "Handbook shortcut",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: {
              targetId: "doc-1",
              targetMimeType: "application/vnd.google-apps.document",
            },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const files = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root" }));

    // `documents` is unique on (connection_id, external_id), so a second copy
    // would be a constraint fight on every sync rather than a second document.
    expect(files.map((f) => f.externalId)).toEqual(["doc-1"]);
    // And the target was recognised without being fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips a shortcut to something it could not read anyway", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files/photo")) {
        return json({ id: "photo", name: "team.jpg", mimeType: "image/jpeg" });
      }
      return json({
        files: [
          {
            id: "short-p",
            name: "team shortcut",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: { targetId: "photo", targetMimeType: "image/jpeg" },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const listed = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root" }));
    expect(listed.filter((f) => !f.skipReason)).toEqual([]);
  });

  // Listed with the reason rather than left out: left out, nobody was told, and
  // a document that grew past the limit looked deleted at the source.
  it("lists a file bigger than the upload form would have taken, marked as skipped", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        files: [
          {
            id: "huge",
            name: "dump.json",
            mimeType: "application/json",
            size: String(11 * 1024 * 1024),
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const listed = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "f" }));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ externalId: "huge", skipReason: "larger than 10 MB" });
  });

  it("skips one file Drive will not export, rather than reading it as a revoked grant", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("export")) {
        return new Response(
          JSON.stringify({ error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }),
          { status: 403 },
        );
      }
      return json({
        id: "s1",
        name: "Ledger",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
    }) as unknown as typeof fetch;

    await expect(
      googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
        externalId: "s1",
        name: "Ledger.csv",
        version: "v1",
        url: null,
      }),
    ).rejects.toBeInstanceOf(FileSkip);
  });

  // Markdown export is comparatively new. A Doc that cannot produce it should
  // arrive as plain text rather than not arrive.
  it("falls back to plain text when a Doc cannot export Markdown", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("export") && url.includes("markdown")) {
        return new Response("no", { status: 400 });
      }
      if (url.includes("export")) return new Response("Plain body", { status: 200 });
      return json({
        id: "doc-1",
        name: "Handbook",
        mimeType: "application/vnd.google-apps.document",
      });
    }) as unknown as typeof fetch;

    const text = await googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
      externalId: "doc-1",
      name: "Handbook.md",
      version: "v1",
      url: null,
    });

    expect(text).toBe("Plain body");
  });

  it("downloads an ordinary text file rather than exporting it", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("alt=media")) return new Response("id,name\n1,Deniz", { status: 200 });
      return json({ id: "csv-1", name: "people.csv", mimeType: "text/csv" });
    }) as unknown as typeof fetch;

    const text = await googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
      externalId: "csv-1",
      name: "people.csv",
      version: "v1",
      url: null,
    });

    expect(text).toBe("id,name\n1,Deniz");
  });

  // CSV is the first tab only; a workbook is all of them.
  it("exports a Sheet as a workbook, so every tab comes with it", async () => {
    const workbook = await makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="March" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>total</t></is></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>rent</t></is></c></row></sheetData></worksheet>`,
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/export")) {
        expect(new URL(url).searchParams.get("mimeType")).toMatch(/spreadsheetml/);
        return new Response(workbook.slice(), { status: 200 });
      }
      return json({
        id: "sheet-1",
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
    }) as unknown as typeof fetch;

    const read = await googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
      externalId: "sheet-1",
      name: "Budget.xlsx",
      version: "v1",
      url: null,
    });

    const { text, original } = read as { text: string; original: Uint8Array };
    expect(text).toContain("## Sheet: Summary");
    expect(text).toContain("## Sheet: March");
    expect(original).toEqual(workbook);
  });

  it("reads a PDF's text, and keeps the PDF", async () => {
    const pdf = tinyPdf("Notice period is one month");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("alt=media")) return new Response(pdf.slice(), { status: 200 });
      return json({ id: "pdf-1", name: "contract.pdf", mimeType: "application/pdf" });
    }) as unknown as typeof fetch;

    const read = await googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
      externalId: "pdf-1",
      name: "contract.pdf",
      version: "v1",
      url: null,
    });

    expect(typeof read).toBe("object");
    const { text, original } = read as { text: string; original: Uint8Array };
    expect(text).toContain("Notice period is one month");
    expect(original).toEqual(pdf);
  });

  it("names a file that is not what its name says, rather than failing the run", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("alt=media")) return new Response("not a pdf at all", { status: 200 });
      return json({ id: "pdf-2", name: "broken.pdf", mimeType: "application/pdf" });
    }) as unknown as typeof fetch;

    await expect(
      googleDriveProvider.readFile(ctx(fetchImpl, { folderId: "f" }), {
        externalId: "pdf-2",
        name: "broken.pdf",
        version: "v1",
        url: null,
      }),
    ).rejects.toBeInstanceOf(FileSkip);
  });

  // The listing used to drop these without a word, and a folder of them
  // synced as an empty bundle with nothing on the run to say why.
  it("gives every file it cannot read a reason", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        files: [
          { id: "a", name: "lyrics.doc", mimeType: "application/msword" },
          { id: "b", name: "cover.png", mimeType: "image/png" },
          { id: "c", name: "demo.mp3", mimeType: "audio/mpeg" },
          { id: "d", name: "Signup", mimeType: "application/vnd.google-apps.form" },
          { id: "e", name: "blob.bin", mimeType: "application/octet-stream" },
        ],
      }),
    ) as unknown as typeof fetch;

    const listed = await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "root" }));

    const reasons = Object.fromEntries(listed.map((f) => [f.externalId, f.skipReason]));
    expect(reasons.a).toMatch(/old Office format/);
    expect(reasons.b).toMatch(/an image/);
    expect(reasons.c).toMatch(/audio/);
    expect(reasons.d).toMatch(/Google Form/);
    expect(reasons.e).toMatch(/cannot read \(application\/octet-stream\)/);
  });

  it("lists folders for the picker, including shared drives", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      return json({ files: [{ id: "f1", name: "Handbook" }] });
    }) as unknown as typeof fetch;

    expect(await listFolders(ctx(fetchImpl), "root")).toEqual([{ id: "f1", name: "Handbook" }]);
  });
});

describe("revoking a Drive grant", () => {
  it("hands Google the refresh token, which ends the whole grant", async () => {
    let sent: { url: string; body: string } | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      sent = { url, body: String(init?.body) };
      return new Response("", { status: 200 });
    });

    await googleDriveProvider.revoke!(
      {},
      { accessToken: "a", refreshToken: "r" },
      fetchImpl as never,
    );

    expect(sent?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(sent?.body).toBe("token=r");
  });

  it("takes Google's 400 — the token is already invalid — as done", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_token", { status: 400 }));
    await expect(
      googleDriveProvider.revoke!({}, { accessToken: "a" }, fetchImpl as never),
    ).resolves.toBeUndefined();
  });
});
