import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchSource = vi.fn();
vi.mock("../lib/routines/source", () => ({
  fetchSource: (...a: unknown[]) => fetchSource(...a),
}));

import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { bundles } from "./bundles";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  fetchSource.mockReset();
});

const allow = {
  check: async () => ({ allowed: true }) as const,
  record: async () => {},
  snapshot: async () => ({ metered: false as const }),
};

async function app() {
  const root = await mkdtemp(join(tmpdir(), "covan-url-"));
  roots.push(root);
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
  });
  const hono = new Hono<AppEnv>();
  hono.use("/*", async (c, next) => {
    c.set("user", { id: "u1" } as never);
    c.set("db", fake.db as never);
    c.set("entitlements", allow as never);
    await next();
  });
  hono.route("/", bundles);
  const add = (url: string) =>
    hono.request(
      "/bundles/bundle-1/documents/url",
      {
        method: "POST",
        body: JSON.stringify({ url }),
        headers: { "content-type": "application/json" },
      },
      { DOCS_DIR: root, ALLOWED_ORIGIN: "https://app.example.com" } as never,
    );
  return { fake, add };
}

describe("POST /bundles/:id/documents/url", () => {
  it("adds the page under its title, queued for indexing", async () => {
    fetchSource.mockResolvedValue({
      status: "content",
      text: "<html><head><title>Leave &amp; holidays</title></head><body><p>Twenty days a year.</p></body></html>",
      hash: "h",
      etag: null,
    });
    const { fake, add } = await app();

    const res = await add("https://intranet.example.com/leave");

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      name: "Leave & holidays.html",
      indexStatus: "queued",
    });
    const insert = fake.callsTo("documents").find((c) => c.op === "insert");
    expect((insert?.values as { content: string }).content).toContain("Twenty days a year.");
  });

  it("says why when the page cannot be fetched", async () => {
    fetchSource.mockRejectedValue(new Error("address resolves to a private network"));
    const { add } = await app();

    const res = await add("https://10.0.0.1/admin");

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/private network/);
  });

  it("refuses a page with no readable text", async () => {
    fetchSource.mockResolvedValue({
      status: "content",
      text: "<html><body><script>render()</script></body></html>",
      hash: "h",
      etag: null,
    });
    const { add } = await app();
    expect((await add("https://app.example.org")).status).toBe(422);
  });
});

describe("POST /bundles/:id/documents/upload with a scanned PDF", () => {
  async function upload(env: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "covan-scan-"));
    roots.push(root);
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
    });
    const hono = new Hono<AppEnv>();
    hono.use("/*", async (c, next) => {
      c.set("user", { id: "u1" } as never);
      c.set("db", fake.db as never);
      c.set("entitlements", allow as never);
      await next();
    });
    hono.route("/", bundles);
    const form = new FormData();
    form.append("file", new File(["%PDF-1.7 pixels"], "scan.pdf", { type: "application/pdf" }));
    return hono.request("/bundles/bundle-1/documents/upload", { method: "POST", body: form }, {
      DOCS_DIR: root,
      ...env,
    } as never);
  }

  // It used to be refused with "run it through OCR", advice most people
  // cannot take. With a Claude key the indexing job reads it as a scan.
  it("takes it for reading when this deployment can read scans", async () => {
    const res = await upload({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ indexStatus: "queued" });
  });

  it("refuses it, saying why, when it cannot", async () => {
    const res = await upload({});
    expect(res.status).toBe(422);
  });
});
