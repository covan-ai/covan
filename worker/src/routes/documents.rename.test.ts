import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { documents } from "./documents";

function app(row: { connection_id: string | null }) {
  const fake = fakeDb({
    tables: {
      documents: {
        select: () => ({ data: { id: "d1", name: "old.md", ...row }, error: null }),
        update: (ctx: QueryContext) => ({
          data: {
            id: "d1",
            name: (ctx.values as { name: string }).name,
            size: 1,
            created_at: "2026-10-15T00:00:00.000Z",
            bundle_id: "b1",
            connection_id: null,
            external_url: null,
            document_chunks: [{ count: 3 }],
          },
          error: null,
        }),
      },
      document_chunks: { update: () => ({ data: null, error: null }) },
    },
  });
  const hono = new Hono<AppEnv>();
  hono.use("/*", async (c, next) => {
    c.set("user", { id: "u1" } as never);
    c.set("db", fake.db as never);
    await next();
  });
  hono.route("/", documents);
  const rename = (name: string) =>
    hono.request("/documents/d1", {
      method: "PATCH",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    });
  return { fake, rename };
}

describe("PATCH /documents/:id with a name", () => {
  // The lexical arm matches on the name through the passages' `context`, so
  // they are renamed with the document or a search for the new name misses.
  it("renames the document and its passages' context", async () => {
    const { fake, rename } = app({ connection_id: null });

    const res = await rename("  new.md ");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "new.md", chunkCount: 3 });
    const chunks = fake.callsTo("document_chunks").find((c) => c.op === "update");
    expect(chunks?.values).toEqual({ context: "new.md" });
  });

  it("refuses a synced file, whose name the next sync would put back", async () => {
    const { rename } = app({ connection_id: "conn-1" });
    expect((await rename("mine.md")).status).toBe(409);
  });

  it("refuses an empty name", async () => {
    const { rename } = app({ connection_id: null });
    expect((await rename("   ")).status).toBe(400);
  });
});
