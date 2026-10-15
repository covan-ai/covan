import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/embeddings")>()),
  embedTexts: vi.fn(async (_env: unknown, texts: string[]) => ({
    vectors: texts.map(() => [0.1]),
    tokens: texts.length,
  })),
}));

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

  const fake = fakeDb({
    tables: {
      documents: {
        select: () => ({
          data: {
            id: "d1",
            name: doc.name,
            size: 1,
            created_at: "2026-10-01T00:00:00.000Z",
            bundle_id: "b1",
            r2_key: "b1/file",
            content: doc.content,
            knowledge_bundles: { workspace_id: "ws-1" },
          },
          error: null,
        }),
      },
      document_chunks: {
        select: () => ({ data: [{ generation: 0 }], error: null }),
        insert: () => ({ data: null, error: null }),
        delete: () => ({ data: null, error: null }),
      },
    },
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

const insertedText = (fake: Awaited<ReturnType<typeof setup>>["fake"]) =>
  fake
    .callsTo("document_chunks")
    .filter((c) => c.op === "insert")
    .flatMap((c) => c.values as unknown as Array<{ content: string }>)
    .map((r) => r.content)
    .join("");

describe("POST /documents/:id/reindex", () => {
  // It used to fall back to the 8,000-character excerpt for every PDF, so a
  // reindex cut a long PDF down to its first pages and called it repaired.
  it("re-embeds a PDF from the whole text its upload kept", async () => {
    const whole = "Clause. ".repeat(3000); // 24,000 characters
    const { fake, reindex } = await setup(
      { name: "contract.pdf", content: whole.slice(0, EXCERPT_LIMIT) },
      { "b1/file": "%PDF-1.7 binary", [sidecarKey("b1/file")]: whole },
    );

    const res = await reindex();

    expect(res.status).toBe(200);
    expect(insertedText(fake)).toContain(whole.slice(20000, 20100));
    // And the previous passages are cleared only after the new ones are in.
    const ops = fake.callsTo("document_chunks").map((c) => c.op);
    expect(ops.lastIndexOf("delete")).toBeGreaterThan(ops.indexOf("insert"));
  });

  it("refuses rather than shortens a PDF that only ever kept its excerpt", async () => {
    const { fake, reindex } = await setup(
      { name: "old.pdf", content: "x".repeat(EXCERPT_LIMIT) },
      { "b1/file": "%PDF-1.7 binary" },
    );

    const res = await reindex();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "excerpt_only" });
    expect(fake.callsTo("document_chunks").some((c) => c.op === "delete")).toBe(false);
  });

  it("re-reads a text file from the store", async () => {
    const whole = "Leave policy. ".repeat(1000);
    const { fake, reindex } = await setup(
      { name: "handbook.md", content: whole.slice(0, EXCERPT_LIMIT) },
      { "b1/file": whole },
    );

    expect((await reindex()).status).toBe(200);
    expect(insertedText(fake).length).toBeGreaterThan(EXCERPT_LIMIT);
  });
});
