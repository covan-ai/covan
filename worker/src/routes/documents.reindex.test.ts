import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AppEnv } from "../types";
import { documents } from "./documents";
import { fakeDb } from "../test-support/fake-db";
import { getDocStore } from "../lib/docstore";
import { sidecarKey } from "../lib/document-text";
import { EXCERPT_LIMIT } from "../lib/extract";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const allow = {
  check: async () => ({ allowed: true }) as const,
  record: async () => {},
  snapshot: async () => ({ metered: false as const }),
};

async function setup(doc: { name: string; content: string }, stored: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "covan-reindex-"));
  roots.push(root);
  const store = getDocStore({ DOCS_DIR: root } as never);
  for (const [key, text] of Object.entries(stored)) {
    const bytes = new TextEncoder().encode(text);
    await store.put(key, bytes.buffer as ArrayBuffer, { contentType: "text/plain" });
  }

  const row = {
    id: "d1",
    name: doc.name,
    size: 1,
    created_at: "2026-10-01T00:00:00.000Z",
    bundle_id: "b1",
    r2_key: "b1/file",
    content: doc.content,
    knowledge_bundles: { workspace_id: "ws-1" },
  };
  const fake = fakeDb({
    tables: {
      documents: {
        select: (ctx) =>
          ctx.columns?.includes("index_status")
            ? {
                data: { ...row, index_status: "queued", document_chunks: [{ count: 4 }] },
                error: null,
              }
            : { data: row, error: null },
      },
    },
    rpc: { queue_document_index: () => ({ data: null, error: null }) },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("db", fake.db as never);
    c.set("entitlements", allow as never);
    await next();
  });
  app.route("/", documents);
  const reindex = () =>
    app.request("/documents/d1/reindex", { method: "POST" }, { DOCS_DIR: root } as never);
  return { fake, reindex };
}

describe("POST /documents/:id/reindex", () => {
  // It used to re-embed inside the request; now it queues the job and returns,
  // and the passages the document has keep answering until the new set is in.
  it("queues the document and says so", async () => {
    const whole = "Clause. ".repeat(3000);
    const { reindex } = await setup(
      { name: "contract.pdf", content: whole.slice(0, EXCERPT_LIMIT) },
      { "b1/file": "%PDF-1.7 binary", [sidecarKey("b1/file")]: whole },
    );

    const res = await reindex();

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id: "d1", indexStatus: "queued", chunkCount: 4 });
  });

  // An old PDF that only ever kept its excerpt would be indexed as though the
  // first eight thousand characters were the document.
  it("refuses rather than shortens a PDF that only ever kept its excerpt", async () => {
    const { reindex } = await setup(
      { name: "old.pdf", content: "x".repeat(EXCERPT_LIMIT) },
      { "b1/file": "%PDF-1.7 binary" },
    );

    const res = await reindex();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "excerpt_only" });
  });

  it("queues a text file, whose original can always be read again", async () => {
    const { reindex } = await setup(
      { name: "handbook.md", content: "x".repeat(EXCERPT_LIMIT) },
      { "b1/file": "Leave policy. ".repeat(1000) },
    );

    expect((await reindex()).status).toBe(202);
  });
});
