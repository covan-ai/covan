import { Hono } from "hono";
import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb } from "../test-support/fake-db";
import { trash } from "./trash";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

function app(opts: { apiKey?: boolean; error?: { code: string; message: string } } = {}) {
  const fake = fakeDb({
    rpc: {
      forget_deleted: () =>
        opts.error
          ? { data: null, error: opts.error }
          : { data: [{ r2_key: "b1/one.pdf" }], error: null },
    },
  });
  const hono = new Hono<AppEnv>();
  hono.use("/*", async (c, next) => {
    c.set("user", { id: "u1" } as never);
    c.set("db", fake.db as never);
    if (opts.apiKey) c.set("apiKeyId", "k1" as never);
    await next();
  });
  hono.route("/", trash);
  return hono;
}

describe("DELETE /trash/:kind/:id", () => {
  it("deletes the rows, then the file and the text kept beside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "covan-forget-"));
    roots.push(root);
    await mkdir(join(root, "b1"), { recursive: true });
    await writeFile(join(root, "b1", "one.pdf"), "pdf");
    await writeFile(join(root, "b1", "one.pdf.txt"), "text");

    const res = await app().request("/trash/document/d1", { method: "DELETE" }, {
      DOCS_DIR: root,
    } as never);

    expect(res.status).toBe(200);
    expect(await readdir(join(root, "b1"))).toEqual([]);
  });

  // The thirty days are the undo. A leaked key does not get to remove them.
  it("is not something an API key may do", async () => {
    const res = await app({ apiKey: true }).request("/trash/document/d1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("says not found for something the caller cannot see", async () => {
    const res = await app({ error: { code: "P0002", message: "nope" } }).request(
      "/trash/bundle/b9",
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("only takes bundles and documents", async () => {
    expect((await app().request("/trash/agent/a1", { method: "DELETE" })).status).toBe(404);
  });
});
