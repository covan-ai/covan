import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type QueryContext } from "../test-support/fake-db";
import { workspaceIcons, workspaceIconsPublic } from "./workspace-icons";

/**
 * A workspace's icon (0127): `avatars.test.ts`' rules with a workspace in the
 * person's place — the bytes decide the type, a member's upload is taken
 * back, and the public route serves only the exact shape it wrote.
 */

const stored = new Map<string, ArrayBuffer>();
const storePut = vi.fn(async (key: string, bytes: ArrayBuffer) => {
  stored.set(key, bytes);
});
const storeDelete = vi.fn(async (key: string) => {
  stored.delete(key);
});
const storeGet = vi.fn(async (key: string) => {
  const hit = stored.get(key);
  return hit ? { body: new Response(hit).body!, contentType: "text/html" } : null;
});
vi.mock("../lib/docstore", () => ({
  getDocStore: () => ({ put: storePut, delete: storeDelete, get: storeGet }),
}));

const USER = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const WS = "1c7f4d2e-3b5e-4f90-8a2c-4d6e8f0a2b3c";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

function appWith(updatedRows: 0 | 1, current: string | null = null) {
  const { db, callsTo } = fakeDb({
    tables: {
      ...activeWorkspaceTables(USER, WS),
      workspaces: {
        select: () => ({ data: { icon_url: current }, error: null }),
        update: (ctx: QueryContext) => ({
          data: updatedRows ? [{ id: WS, icon_url: ctx.values?.icon_url ?? null }] : [],
          error: null,
        }),
      },
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: USER } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", workspaceIcons);
  app.route("/", workspaceIconsPublic);
  return { app, callsTo };
}

function upload(app: Hono<AppEnv>, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new File([bytes], "icon.png", { type: "image/png" }));
  return app.request("/workspace/icon", { method: "PUT", body: form });
}

beforeEach(() => {
  stored.clear();
  storePut.mockClear();
  storeDelete.mockClear();
});

describe("PUT /workspace/icon", () => {
  it("stores the image under the workspace and points the row at it", async () => {
    const { app } = appWith(1);
    const res = await upload(app, PNG);
    expect(res.status).toBe(200);
    const { iconUrl } = (await res.json()) as { iconUrl: string };
    expect(iconUrl).toMatch(new RegExp(`^/workspace-icons/${WS}/[0-9a-f]{32}\\.png$`));
    expect(stored.has(iconUrl.slice(1))).toBe(true);
  });

  it("refuses what is not an image, whatever it is called", async () => {
    const { app } = appWith(1);
    expect((await upload(app, SVG)).status).toBe(415);
    expect(storePut).not.toHaveBeenCalled();
  });

  it("takes the bytes back when the row refuses a member", async () => {
    const { app } = appWith(0);
    const res = await upload(app, PNG);
    expect(res.status).toBe(403);
    expect(stored.size).toBe(0);
  });

  it("deletes the icon it replaced", async () => {
    const old = `/workspace-icons/${WS}/${"a".repeat(32)}.png`;
    stored.set(old.slice(1), new ArrayBuffer(1));
    const { app } = appWith(1, old);
    await upload(app, PNG);
    expect(stored.has(old.slice(1))).toBe(false);
  });
});

describe("GET /workspace-icons/:workspaceId/:file", () => {
  it("serves only the exact shape it wrote, as an image", async () => {
    const key = `workspace-icons/${WS}/${"b".repeat(32)}.png`;
    stored.set(key, PNG.buffer.slice(0));
    const { app } = appWith(1);
    const ok = await app.request(`/${key}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect((await app.request(`/workspace-icons/${WS}/..%2Fsecret.png`)).status).toBe(404);
    expect((await app.request(`/workspace-icons/not-a-uuid/${"b".repeat(32)}.png`)).status).toBe(
      404,
    );
  });
});
