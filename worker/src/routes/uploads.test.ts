import { Hono } from "hono";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { PART_BYTES, uploads } from "./uploads";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "covan-parts-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const allow = {
  check: async () => ({ allowed: true }) as const,
  record: async () => {},
  snapshot: async () => ({ metered: false as const }),
};

function app(opts: { canWrite?: boolean; user?: string } = {}) {
  const fake = fakeDb({
    tables: {
      knowledge_bundles: {
        select: () => ({ data: { id: "bundle-1", workspace_id: "ws-1" }, error: null }),
      },
      documents: {
        insert: (ctx: QueryContext) => ({
          data: { id: "doc-1", created_at: "2026-10-15T00:00:00.000Z", ...ctx.values },
          error: null,
        }),
      },
    },
    rpc: { can_write_in_workspace: () => ({ data: opts.canWrite ?? true, error: null }) },
  });
  const hono = new Hono<AppEnv>();
  hono.use("/*", async (c, next) => {
    c.set("user", { id: opts.user ?? "user-1" } as never);
    c.set("db", fake.db as never);
    c.set("entitlements", allow as never);
    await next();
  });
  hono.route("/", uploads);
  const env = { DOCS_DIR: root, ROUTINE_SECRET_KEY: "a-test-secret" } as never;
  const json = (path: string, body: unknown) =>
    hono.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
      env,
    );
  const put = (n: number, token: string, bytes: Uint8Array, to = "file") =>
    hono.request(
      `/uploads/parts?n=${n}&to=${to}`,
      { method: "PUT", body: bytes, headers: { "x-upload-token": token } },
      env,
    );
  return { fake, json, put };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("an upload in parts", () => {
  it("assembles the parts, stores the file and queues the document", async () => {
    const { fake, json, put } = app();
    const first = new Uint8Array(PART_BYTES).fill(0x61); // "a" × 8 MiB
    const second = bytes(" and the rest of the handbook.");
    const size = first.length + second.length;

    const start = await json("/bundles/bundle-1/uploads", { name: "handbook.md", size });
    expect(start.status).toBe(201);
    const { token, partSize } = (await start.json()) as { token: string; partSize: number };
    expect(partSize).toBe(PART_BYTES);

    const p2 = await (await put(2, token, second)).json();
    const p1 = await (await put(1, token, first)).json();
    const done = await json("/uploads/complete", { token, parts: [p1, p2] });

    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({
      id: "doc-1",
      name: "handbook.md",
      indexStatus: "queued",
    });
    const insert = fake.callsTo("documents").find((c) => c.op === "insert");
    expect(insert?.values).toMatchObject({ bundle_id: "bundle-1", size, index_status: "queued" });

    const [stored] = (await readdir(join(root, "bundle-1"))).filter((f) =>
      f.endsWith("-handbook.md"),
    );
    const file = await readFile(join(root, "bundle-1", stored));
    expect(file.length).toBe(size);
    expect(file.subarray(PART_BYTES).toString()).toBe(" and the rest of the handbook.");
  });

  it("keeps a PDF's text beside it, and refuses one with none", async () => {
    const { json, put } = app();
    const pdf = bytes("%PDF-1.7 pretend");

    const start = await json("/bundles/bundle-1/uploads", {
      name: "scan.pdf",
      size: pdf.length,
      withText: true,
    });
    const { token } = (await start.json()) as { token: string };
    const part = await (await put(1, token, pdf)).json();
    const text = await (await put(1, token, bytes("   "), "text")).json();
    const done = await json("/uploads/complete", { token, parts: [part], textParts: [text] });

    expect(done.status).toBe(422);
    expect(((await done.json()) as { error: string }).error).toMatch(/looks like a scan/);
    // Nothing is left behind for a refused upload.
    expect(await readdir(join(root, "bundle-1")).catch(() => [])).toEqual([]);
  });

  it("refuses a file that is not the size it said it was", async () => {
    const { json, put } = app();
    const start = await json("/bundles/bundle-1/uploads", { name: "notes.txt", size: 5 });
    const { token } = (await start.json()) as { token: string };
    const part = await (await put(1, token, bytes("much longer than five"))).json();

    const done = await json("/uploads/complete", { token, parts: [part] });

    expect(done.status).toBe(400);
  });

  it("will not take a part that is not the part size, unless it is the last", async () => {
    const { json, put } = app();
    const start = await json("/bundles/bundle-1/uploads", {
      name: "big.csv",
      size: PART_BYTES + 10,
    });
    const { token } = (await start.json()) as { token: string };

    expect((await put(1, token, bytes("short"))).status).toBe(400);
    expect((await put(3, token, bytes("short"))).status).toBe(400);
  });

  it("refuses a token somebody else was given, or one that was changed", async () => {
    const owner = app();
    const start = await owner.json("/bundles/bundle-1/uploads", { name: "notes.txt", size: 5 });
    const { token } = (await start.json()) as { token: string };

    const stranger = app({ user: "user-2" });
    expect((await stranger.put(1, token, bytes("hello"))).status).toBe(401);
    const [body, mac] = token.split(".");
    const forged = `${body.slice(0, -2)}AA.${mac}`;
    expect((await owner.put(1, forged, bytes("hello"))).status).toBe(401);
  });

  it("refuses the start for somebody who cannot write, and the size past the limit", async () => {
    const viewer = app({ canWrite: false });
    expect(
      (await viewer.json("/bundles/bundle-1/uploads", { name: "a.md", size: 10 })).status,
    ).toBe(403);
    const big = app();
    expect(
      (await big.json("/bundles/bundle-1/uploads", { name: "a.md", size: 101 * 1024 * 1024 }))
        .status,
    ).toBe(413);
    expect((await big.json("/bundles/bundle-1/uploads", { name: "a.exe", size: 10 })).status).toBe(
      400,
    );
  });
});
