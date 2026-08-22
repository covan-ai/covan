import { Hono } from "hono";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { bundles } from "./bundles";

// Minimal stand-in for the Supabase client the route pulls off `c.get("db")`.
// Only the `knowledge_bundles` lookup is exercised before the storage write —
// a document row is never expected to be inserted when `put` fails first.
function fakeDb(bundleRow: { id: string; workspace_id: string } | null) {
  let documentsTouched = false;
  const db = {
    from(table: string) {
      if (table === "knowledge_bundles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: bundleRow, error: null }),
            }),
          }),
        };
      }
      if (table === "documents") {
        documentsTouched = true;
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`fakeDb: unexpected table "${table}"`);
    },
  };
  return { db, wasDocumentsTouched: () => documentsTouched };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", bundles);
  return app;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("POST /bundles/:id/documents/upload — storage failure", () => {
  it("returns a clear JSON error (not a bare 500) when the doc store put fails", async () => {
    // Make the fs DocStore's put() fail unconditionally and portably (i.e. even
    // when the test runs as root, where chmod-based permission tricks don't
    // block access): point DOCS_DIR at a path segment that is a regular file,
    // not a directory. `put()` does `mkdir(dirname(file), { recursive: true })`
    // first, which throws ENOTDIR when a path component already exists as a
    // plain file — a structural failure, not a permissions one.
    const root = await mkdtemp(join(tmpdir(), "covan-upload-fail-"));
    roots.push(root);
    const blockerFile = join(root, "blocked-dir");
    await writeFile(blockerFile, "not a directory");

    const { db, wasDocumentsTouched } = fakeDb({ id: "bundle-1", workspace_id: "ws-1" });
    const app = appWithDb(db);

    const form = new FormData();
    form.append("file", new File(["hello world"], "notes.txt", { type: "text/plain" }));

    const res = await app.request(
      "/bundles/bundle-1/documents/upload",
      { method: "POST", body: form },
      // env.DOCS_DIR resolves every key under `blocked-dir`, so pathFor() ends
      // up trying to mkdir a directory where `blocked-dir` (a file) already is.
      { DOCS_DIR: blockerFile } as never,
    );

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);

    // The pre-fix behaviour is Hono's default error path: a bare, non-JSON
    // "Internal Server Error" body. Parsing it as JSON throws, which is what
    // makes this assertion fail before the handler is fixed.
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect((body.error ?? "").length).toBeGreaterThan(0);

    // A failed put happens before the document row is ever inserted, so
    // nothing should need to be rolled back — and nothing should be inserted.
    expect(wasDocumentsTouched()).toBe(false);
  });
});

describe("POST /bundles/:id/documents/upload — files with no readable text", () => {
  // Both of these used to succeed: the file was stored, a row was written with
  // an empty or garbage excerpt, and the document was listed as the agent's
  // while being impossible to retrieve a word of. Refusing costs the user one
  // sentence; accepting costs them a document they believe the agent has read.
  async function upload(file: File, fields: Record<string, string> = {}) {
    const root = await mkdtemp(join(tmpdir(), "covan-upload-text-"));
    roots.push(root);
    const { db, wasDocumentsTouched } = fakeDb({ id: "bundle-1", workspace_id: "ws-1" });
    const app = appWithDb(db);

    const form = new FormData();
    form.append("file", file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await app.request(
      "/bundles/bundle-1/documents/upload",
      { method: "POST", body: form },
      { DOCS_DIR: root } as never,
    );
    return { res, wasDocumentsTouched };
  }

  it("refuses a PDF the browser could not read — the scan with no text layer", async () => {
    // No `text` field: that is exactly what the client sends when its parser
    // came back empty, and the server cannot parse a PDF itself.
    const { res, wasDocumentsTouched } = await upload(
      new File(["%PDF-1.7 binary page images"], "scan.pdf", { type: "application/pdf" }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/text/i);
    expect(wasDocumentsTouched()).toBe(false);
  });

  it("refuses a binary file wearing a text extension — the renamed .docx", async () => {
    const zipish = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0x00]);
    const { res, wasDocumentsTouched } = await upload(
      new File([zipish], "notes.txt", { type: "text/plain" }),
    );

    expect(res.status).toBe(422);
    expect(wasDocumentsTouched()).toBe(false);
  });

  it("still accepts a PDF whose text the browser did extract", async () => {
    const { res } = await upload(
      new File(["%PDF-1.7 ..."], "report.pdf", { type: "application/pdf" }),
      { text: "Quarterly report. Revenue grew across every region." },
    );

    // fakeDb returns a null document row, so the insert path 500s — the point
    // here is only that the text gate let it through to that path at all.
    expect(res.status).not.toBe(422);
  });
});
