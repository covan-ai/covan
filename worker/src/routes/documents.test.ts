import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { documents } from "./documents";

type DocRow = {
  id: string;
  name: string;
  size: number;
  bundle_id: string;
  knowledge_bundles: { workspace_id: string } | null;
};

/**
 * A stand-in for the caller's Supabase client covering exactly the calls the
 * move makes. `chunksMoved` is the interesting knob: RLS answers an update it
 * has no policy for by matching no rows and reporting no error, so "the update
 * went through and changed nothing" has to be expressible here.
 */
function fakeDb(opts: {
  doc: DocRow;
  targetBundle: { id: string; workspace_id: string } | null;
  chunkCount: number;
  chunksMoved?: number;
}) {
  const state = { docBundleId: opts.doc.bundle_id, chunkBundleId: opts.doc.bundle_id };
  const moved = opts.chunksMoved ?? opts.chunkCount;

  const db = {
    from(table: string) {
      if (table === "documents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { ...opts.doc, bundle_id: state.docBundleId },
                error: null,
              }),
            }),
          }),
          update: (patch: { bundle_id: string }) => ({
            eq: () => ({
              select: () => ({
                single: async () => {
                  state.docBundleId = patch.bundle_id;
                  return {
                    data: {
                      id: opts.doc.id,
                      name: opts.doc.name,
                      size: opts.doc.size,
                      document_chunks: [{ count: opts.chunkCount }],
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }
      if (table === "knowledge_bundles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: opts.targetBundle, error: null }) }),
          }),
        };
      }
      if (table === "document_chunks") {
        return {
          select: (_cols: string, _o?: unknown) => ({
            eq: async () => ({ count: opts.chunkCount, error: null }),
          }),
          update: (patch: { bundle_id: string }) => ({
            eq: () => ({
              select: async () => {
                if (moved > 0) state.chunkBundleId = patch.bundle_id;
                return {
                  data: Array.from({ length: moved }, (_, i) => ({ id: `chunk-${i}` })),
                  error: null,
                };
              },
            }),
          }),
        };
      }
      throw new Error(`fakeDb: unexpected table "${table}"`);
    },
  };

  return { db, state };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", documents);
  return app;
}

const doc: DocRow = {
  id: "doc-1",
  name: "notes.md",
  size: 120,
  bundle_id: "chat-bundle",
  knowledge_bundles: { workspace_id: "ws-1" },
};

const move = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/documents/doc-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /documents/:id — moving a document to another bundle", () => {
  it("takes the document's chunks with it", async () => {
    const { db, state } = fakeDb({
      doc,
      targetBundle: { id: "team-bundle", workspace_id: "ws-1" },
      chunkCount: 4,
    });

    const res = await move(appWithDb(db), { bundleId: "team-bundle" });

    expect(res.status).toBe(200);
    // Retrieval scope is read from the chunks, so a move that leaves them
    // behind is the failure this endpoint exists to avoid.
    expect(state.chunkBundleId).toBe("team-bundle");
    expect(state.docBundleId).toBe("team-bundle");
  });

  it("returns the document, still indexed, so the interface can say so", async () => {
    const { db } = fakeDb({
      doc,
      targetBundle: { id: "team-bundle", workspace_id: "ws-1" },
      chunkCount: 4,
    });

    const res = await move(appWithDb(db), { bundleId: "team-bundle" });

    expect(await res.json()).toMatchObject({ id: "doc-1", chunkCount: 4, indexed: true });
  });

  it("fails loudly, and moves nothing, when the chunks cannot be re-pointed", async () => {
    // What a database without 0024 does: no update policy, so the update
    // matches no rows and reports no error.
    const { db, state } = fakeDb({
      doc,
      targetBundle: { id: "team-bundle", workspace_id: "ws-1" },
      chunkCount: 4,
      chunksMoved: 0,
    });

    const res = await move(appWithDb(db), { bundleId: "team-bundle" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(state.docBundleId).toBe("chat-bundle");
  });

  it("refuses a bundle in another workspace", async () => {
    const { db, state } = fakeDb({
      doc,
      targetBundle: { id: "other-bundle", workspace_id: "ws-2" },
      chunkCount: 1,
    });

    const res = await move(appWithDb(db), { bundleId: "other-bundle" });

    expect(res.status).toBe(400);
    expect(state.docBundleId).toBe("chat-bundle");
  });

  it("refuses a request that names no bundle", async () => {
    const { db } = fakeDb({
      doc,
      targetBundle: { id: "team-bundle", workspace_id: "ws-1" },
      chunkCount: 1,
    });

    const res = await move(appWithDb(db), {});

    expect(res.status).toBe(400);
  });

  it("does nothing to a document already in that bundle", async () => {
    const { db } = fakeDb({
      doc,
      targetBundle: { id: "chat-bundle", workspace_id: "ws-1" },
      chunkCount: 2,
    });

    const res = await move(appWithDb(db), { bundleId: "chat-bundle" });

    expect(res.status).toBe(200);
  });
});

/**
 * The caller's client for the delete path, which is now one RPC.
 *
 * `soft_delete_document` checks `can_write_in_workspace` for itself and raises,
 * so the knob that matters is the SQLSTATE. That is the improvement worth
 * keeping in mind while reading these: RLS used to refuse a viewer's delete as
 * "matched no rows, no error", which is indistinguishable from success unless
 * the handler goes looking. A raised exception cannot be mistaken for anything.
 */
function fakeDeleteDb(opts: { code?: string; message?: string } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return {
        data: null,
        error: opts.code ? { code: opts.code, message: opts.message ?? "refused" } : null,
      };
    },
  } as never;
  return { db, calls };
}

function appWith(db: unknown, deleted: string[]) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    // Stand in for the R2/fs store, recording what it was asked to remove.
    // (c.env is undefined in this test harness unless something sets it — see
    // transcribe.test.ts for the same pattern — so this assigns the whole
    // object rather than mutating a DOCS property off of undefined.)
    c.env = {
      DOCS: {
        delete: async (key: string) => {
          deleted.push(key);
        },
      },
    } as never;
    await next();
  });
  app.route("/", documents);
  return app;
}

describe("DELETE /documents/:id", () => {
  it("marks the row and leaves the stored object exactly where it is", async () => {
    const deleted: string[] = [];
    const { db, calls } = fakeDeleteDb();
    const app = appWith(db, deleted);

    const res = await app.request("/documents/d1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ fn: "soft_delete_document", args: { p_document_id: "d1" } }]);

    // The reason the bytes stay: a restored document that came back as a row
    // pointing at a missing file is worse than either outcome on its own. The
    // sweeper deletes both, thirty days later.
    expect(deleted).toEqual([]);
  });

  it("403s when the database refuses, and still touches nothing", async () => {
    const deleted: string[] = [];
    const { db } = fakeDeleteDb({ code: "42501" });
    const app = appWith(db, deleted);

    const res = await app.request("/documents/d1", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(deleted).toEqual([]);
  });

  it("404s for a document the caller cannot see, or that is already deleted", async () => {
    const deleted: string[] = [];
    const { db } = fakeDeleteDb({ code: "P0002" });
    const app = appWith(db, deleted);

    const res = await app.request("/documents/nope", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(deleted).toEqual([]);
  });

  it("500s on anything else rather than reporting a delete that did not happen", async () => {
    const deleted: string[] = [];
    const { db } = fakeDeleteDb({ code: "08006", message: "connection failure" });
    const app = appWith(db, deleted);

    const res = await app.request("/documents/d1", { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(deleted).toEqual([]);
  });
});
