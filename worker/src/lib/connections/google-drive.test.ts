import { describe, it, expect, vi } from "vitest";
import { googleDriveProvider, importableName, listFolders, folderIdOf } from "./google-drive";
import type { ProviderContext } from "./types";

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
      importableName({ id: "2", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }),
    ).toBe("Budget.csv");
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

  // There is no browser in a cron tick, and `lib/extract` returns "" for a PDF
  // — so importing one would produce a document that is listed, named to the
  // model, and impossible to retrieve a sentence of.
  it("refuses the formats it could not read a word of", () => {
    expect(importableName({ id: "5", name: "contract.pdf", mimeType: "application/pdf" })).toBeNull();
    expect(
      importableName({
        id: "6",
        name: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toBeNull();
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
    const url = new URL(googleDriveProvider.authorizeUrl(env, "state", "https://api.example.com/cb"));
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
            { id: "scan", name: "contract.pdf", mimeType: "application/pdf" },
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

    expect(files.map((f) => f.externalId)).toEqual(["doc-1", "doc-2"]);
    expect(files[0]).toMatchObject({
      name: "Handbook.md",
      version: "2026-09-01T10:00:00Z",
      url: "https://docs.google.com/doc-1",
    });
  });

  it("skips a file bigger than the upload form would have taken", async () => {
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

    expect(await googleDriveProvider.listFiles(ctx(fetchImpl, { folderId: "f" }))).toEqual([]);
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
      return json({ id: "doc-1", name: "Handbook", mimeType: "application/vnd.google-apps.document" });
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

  it("lists folders for the picker, including shared drives", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      return json({ files: [{ id: "f1", name: "Handbook" }] });
    }) as unknown as typeof fetch;

    expect(await listFolders(ctx(fetchImpl), "root")).toEqual([{ id: "f1", name: "Handbook" }]);
  });
});
