import { Hono } from "hono";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { bundles } from "./bundles";

// Real chunking, fake vectors: these tests are about what the route does with
// the chunks, and nothing here should reach OpenAI.
vi.mock("../lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/embeddings")>();
  return {
    ...actual,
    embedTexts: async (_apiKey: string, texts: string[]) => ({
      vectors: texts.map(() => new Array(1536).fill(0) as number[]),
      tokens: texts.length,
    }),
  };
});

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

describe("POST /bundles/:id/documents/upload — what the response says about indexing", () => {
  // The response is a DocumentDTO, so it carries `chunkCount` and `indexed`.
  // Both were read off a row selected before the embedding ran and without
  // `document_chunks(count)` in the select, so the endpoint answered "0 chunks,
  // not indexed" for every upload it had just embedded perfectly well. The
  // Knowledge tab never noticed because it re-reads the agent; the chat
  // composer's receipt believed it and called every file unretrievable.
  function fakeDbCounting(chunkRows: { length: number }) {
    const db = {
      from(table: string) {
        if (table === "knowledge_bundles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "bundle-1", workspace_id: "ws-1" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "documents") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: { id: "doc-1", name: "notes.md", size: 11 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "document_chunks") {
          return {
            insert: async (rows: unknown[]) => {
              chunkRows.length = (rows as unknown[]).length;
              return { error: null };
            },
          };
        }
        throw new Error(`fakeDb: unexpected table "${table}"`);
      },
    };
    return db;
  }

  it("reports the chunks it just embedded, not zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "covan-upload-indexed-"));
    roots.push(root);
    const inserted = { length: 0 };
    const app = appWithDb(fakeDbCounting(inserted));

    const form = new FormData();
    form.append(
      "file",
      new File(["a passage worth embedding"], "notes.md", { type: "text/markdown" }),
    );

    const res = await app.request(
      "/bundles/bundle-1/documents/upload",
      { method: "POST", body: form },
      { DOCS_DIR: root, OPENAI_API_KEY: "test-key" } as never,
    );

    expect(res.status).toBe(201);
    expect(inserted.length).toBeGreaterThan(0);
    const body = (await res.json()) as { chunkCount: number; indexed: boolean };
    expect(body.chunkCount).toBe(inserted.length);
    expect(body.indexed).toBe(true);
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

/*
 * GET /bundles/citations
 *
 * The route's own job is small — resolve the workspace, hand its bundle ids to
 * two RPCs, and shape what comes back. The counting itself is in 0038 and is
 * tested against a real database in tests/rls/. What is worth pinning here is
 * the shaping, because every mistake in it is silent: a bigint arriving as a
 * string sorts as text, and a missing `since` reads as "counted from the
 * beginning" rather than "counted from nowhere".
 */
function citationsDb(options: {
  bundleIds?: string[];
  counts?: Array<{ document_id: string; citations: number | string }>;
  since?: string | null;
  bundleError?: boolean;
  rpcError?: boolean;
}) {
  const calls: { rpc: Array<[string, Record<string, unknown>]> } = { rpc: [] };
  const db = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { active_workspace_id: "ws-1" }, error: null }),
            }),
          }),
        };
      }
      // `getActiveWorkspaceId` confirms the active workspace is still one the
      // caller belongs to before it trusts the profile.
      if (table === "workspace_members") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { workspace_id: "ws-1" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "knowledge_bundles") {
        return {
          select: () => ({
            eq: async () => ({
              data: options.bundleError
                ? null
                : (options.bundleIds ?? ["bundle-1"]).map((id) => ({ id })),
              error: options.bundleError ? { message: "boom" } : null,
            }),
          }),
        };
      }
      throw new Error(`citationsDb: unexpected table "${table}"`);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push([name, args]);
      if (options.rpcError) return { data: null, error: { message: "boom" } };
      if (name === "document_citation_counts") return { data: options.counts ?? [], error: null };
      return { data: options.since ?? null, error: null };
    },
  };
  return { db, calls };
}

describe("GET /bundles/citations", () => {
  it("counts against every bundle in the workspace, not only the ones on one agent", async () => {
    const { db, calls } = citationsDb({ bundleIds: ["b1", "b2"] });
    const res = await appWithDb(db).request("/bundles/citations");

    expect(res.status).toBe(200);
    const counting = calls.rpc.find(([name]) => name === "document_citation_counts");
    expect(counting?.[1]).toEqual({ p_bundle_ids: ["b1", "b2"] });
  });

  it("turns a bigint count into a number, whichever way PostgREST sends it", async () => {
    // Counts are bigint. PostgREST sends small ones as JSON numbers and large
    // ones as strings, and a string would sort as text — "9" above "41".
    const { db } = citationsDb({
      counts: [
        { document_id: "d1", citations: "41" },
        { document_id: "d2", citations: 9 },
      ],
    });
    const res = await appWithDb(db).request("/bundles/citations");
    const body = (await res.json()) as { counts: Record<string, number> };

    expect(body.counts).toEqual({ d1: 41, d2: 9 });
    expect(typeof body.counts.d1).toBe("number");
  });

  it("reports the window as a timestamp", async () => {
    const { db } = citationsDb({ since: "2026-08-24T09:15:00.000Z" });
    const res = await appWithDb(db).request("/bundles/citations");
    const body = (await res.json()) as { since: number | null };

    expect(body.since).toBe(Date.parse("2026-08-24T09:15:00.000Z"));
  });

  it("says null rather than a date when nothing has ever been countable", async () => {
    // Not zero, and not the epoch. "No reply has carried a document id yet" is
    // a different screen from "the count starts in 1970".
    const { db } = citationsDb({ since: null });
    const res = await appWithDb(db).request("/bundles/citations");
    const body = (await res.json()) as { since: number | null };

    expect(body.since).toBeNull();
  });

  it("asks nothing of the database when the workspace has no bundles", async () => {
    const { db, calls } = citationsDb({ bundleIds: [] });
    const res = await appWithDb(db).request("/bundles/citations");

    expect(await res.json()).toEqual({ since: null, counts: {} });
    expect(calls.rpc).toHaveLength(0);
  });

  it("fails loudly rather than reporting an empty count", async () => {
    // The failure mode worth avoiding: an error swallowed into `{}` would draw
    // a panel saying nothing needs revisiting, which is a claim rather than an
    // absence of one.
    const { db } = citationsDb({ rpcError: true });
    const res = await appWithDb(db).request("/bundles/citations");

    expect(res.status).toBe(500);
  });
});
