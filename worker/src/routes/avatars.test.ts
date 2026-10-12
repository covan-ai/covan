import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { AVATAR_MAX_BYTES } from "../lib/avatars";
import { avatars, avatarsPublic } from "./avatars";

/**
 * The store, in memory. `getDocStore` is the seam every route uses, so this is
 * the whole of the runtime difference between R2 and the filesystem as far as
 * these routes can tell.
 */
const stored = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
const storePut = vi.fn(async (key: string, bytes: ArrayBuffer, opts: { contentType: string }) => {
  stored.set(key, { bytes, contentType: opts.contentType });
});
const storeDelete = vi.fn(async (key: string) => {
  stored.delete(key);
});
const storeGet = vi.fn(async (key: string) => {
  const hit = stored.get(key);
  if (!hit) return null;
  return {
    // The object's own recorded type is deliberately wrong here: the route must
    // serve the type its validated extension implies, never this.
    contentType: "text/html",
    body: new Response(hit.bytes).body!,
    arrayBuffer: async () => hit.bytes,
  };
});
vi.mock("../lib/docstore", () => ({
  getDocStore: () => ({ put: storePut, delete: storeDelete, get: storeGet }),
}));

const USER_ID = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const OLD_FILE = "ffffffffffffffffffffffffffffffff.jpg";
const OLD_PATH = `/avatars/${USER_ID}/${OLD_FILE}`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

type Spec = {
  /** The `avatar_url` already on the caller's row. */
  current?: string | null;
  /** How many rows the update reports; 0 is RLS refusing. */
  updatedRows?: 0 | 1;
  updateError?: boolean;
};

function appWith(spec: Spec = {}) {
  const updates: Array<{ values: unknown; filters: QueryContext["filters"] }> = [];
  const { db } = fakeDb({
    tables: {
      profiles: {
        select: () => ({ data: { avatar_url: spec.current ?? null }, error: null }),
        update: (ctx) => {
          updates.push({ values: ctx.values, filters: ctx.filters });
          if (spec.updateError) return { data: null, error: { message: "boom" } };
          const rows =
            spec.updatedRows === 0
              ? []
              : [
                  {
                    id: USER_ID,
                    name: "Efe",
                    email: "a@example.com",
                    bio: null,
                    locale: null,
                    timezone: null,
                    ...(ctx.values as Record<string, unknown>),
                  },
                ];
          return { data: rows, error: null };
        },
      },
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/me/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "a@example.com" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", avatars);
  app.route("/", avatarsPublic);
  return { app, updates };
}

function upload(
  app: Hono<AppEnv>,
  bytes: Uint8Array,
  opts: { type?: string; headers?: Record<string, string> } = {},
) {
  const form = new FormData();
  form.append("file", new File([bytes], "me.png", { type: opts.type ?? "image/png" }));
  return app.request("/me/avatar", { method: "PUT", body: form, headers: opts.headers });
}

const putKeys = () => storePut.mock.calls.map((call) => call[0]);
const deletedKeys = () => storeDelete.mock.calls.map((call) => call[0]);

beforeEach(() => {
  stored.clear();
  vi.clearAllMocks();
});

describe("PUT /me/avatar", () => {
  it("stores the photo under a fresh key and points the caller's own row at it", async () => {
    const { app, updates } = appWith();

    const res = await upload(app, PNG);

    expect(res.status).toBe(200);
    expect(putKeys()).toHaveLength(1);
    const key = putKeys()[0];
    expect(key).toMatch(new RegExp(`^avatars/${USER_ID}/[0-9a-f]{32}\\.png$`));
    expect(storePut.mock.calls[0][2]).toEqual({ contentType: "image/png" });
    expect(updates).toEqual([
      {
        values: { avatar_url: `/${key}` },
        filters: [{ column: "id", value: USER_ID, kind: "eq" }],
      },
    ]);
    await expect(res.json()).resolves.toEqual({
      id: USER_ID,
      name: "Efe",
      email: "a@example.com",
      avatarUrl: `/${key}`,
      bio: null,
      locale: null,
      timezone: null,
    });
  });

  // The client's `file.type` is the client's say. The bytes are an SVG, and
  // an SVG can carry script; it is refused before anything is stored.
  it("refuses an SVG that claims to be a PNG", async () => {
    const { app, updates } = appWith();

    const res = await upload(app, SVG, { type: "image/png" });

    expect(res.status).toBe(415);
    expect(storePut).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("refuses a photo over the limit, by its declared length or its real size", async () => {
    const { app } = appWith();

    const declared = await upload(app, PNG, {
      headers: { "content-length": String(AVATAR_MAX_BYTES * 2) },
    });
    expect(declared.status).toBe(413);

    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    const real = await upload(app, big);
    expect(real.status).toBe(413);

    expect(storePut).not.toHaveBeenCalled();
  });

  it("refuses a request with no file, or an empty one", async () => {
    const { app } = appWith();

    expect((await app.request("/me/avatar", { method: "PUT", body: new FormData() })).status).toBe(
      400,
    );
    expect((await upload(app, new Uint8Array())).status).toBe(400);
    expect(storePut).not.toHaveBeenCalled();
  });

  // Zero rows is RLS refusing. The object written a moment ago belongs to no
  // row now, so it is taken back rather than left where no erasure can find it.
  it("takes the new object back when the row refuses it", async () => {
    const { app } = appWith({ updatedRows: 0, current: OLD_PATH });

    const res = await upload(app, PNG);

    expect(res.status).toBe(500);
    expect(deletedKeys()).toEqual([putKeys()[0]]);
  });

  it("takes the new object back when the update errors", async () => {
    const { app } = appWith({ updateError: true });

    expect((await upload(app, PNG)).status).toBe(500);
    expect(deletedKeys()).toEqual([putKeys()[0]]);
  });

  it("deletes the photo it replaces, once the row has moved on", async () => {
    const { app } = appWith({ current: OLD_PATH });

    expect((await upload(app, PNG)).status).toBe(200);
    expect(deletedKeys()).toEqual([`avatars/${USER_ID}/${OLD_FILE}`]);
  });

  // A provider's photo is somebody else's file. There is nothing of ours to
  // delete, and a key built from it would be a delete somebody else steered.
  it("deletes nothing when the photo it replaces was not ours", async () => {
    const { app } = appWith({ current: "https://lh3.example.com/a/photo.jpg" });

    expect((await upload(app, PNG)).status).toBe(200);
    expect(storeDelete).not.toHaveBeenCalled();
  });
});

describe("DELETE /me/avatar", () => {
  it("clears the row first, then deletes the object", async () => {
    const order: string[] = [];
    const { app, updates } = appWith({ current: OLD_PATH });
    storeDelete.mockImplementationOnce(async () => {
      order.push(`delete after ${updates.length} update(s)`);
    });

    const res = await app.request("/me/avatar", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(updates.map((u) => u.values)).toEqual([{ avatar_url: null }]);
    expect(deletedKeys()).toEqual([`avatars/${USER_ID}/${OLD_FILE}`]);
    expect(order).toEqual(["delete after 1 update(s)"]);
    await expect(res.json()).resolves.toMatchObject({ avatarUrl: null });
  });

  it("leaves the object alone when the row refuses", async () => {
    const { app } = appWith({ current: OLD_PATH, updatedRows: 0 });

    expect((await app.request("/me/avatar", { method: "DELETE" })).status).toBe(500);
    expect(storeDelete).not.toHaveBeenCalled();
  });

  it("deletes nothing for a photo that was not ours", async () => {
    const { app } = appWith({ current: "https://lh3.example.com/a/photo.jpg" });

    expect((await app.request("/me/avatar", { method: "DELETE" })).status).toBe(200);
    expect(storeDelete).not.toHaveBeenCalled();
  });
  // `avatar_url` is the caller's own column to write, and a co-member's photo
  // path is right there in /me. Copied into your own row, it must not turn
  // your removal (or your next upload) into a delete of their photo.
  it("deletes nothing for a co-member's photo path written into the caller's row", async () => {
    const theirs = `/avatars/11111111-2222-4333-8444-555555555555/${OLD_FILE}`;
    const { app } = appWith({ current: theirs });

    expect((await app.request("/me/avatar", { method: "DELETE" })).status).toBe(200);
    expect(storeDelete).not.toHaveBeenCalled();

    const again = appWith({ current: theirs });
    expect((await upload(again.app, PNG)).status).toBe(200);
    expect(storeDelete).not.toHaveBeenCalled();
  });
});

describe("GET /avatars/:userId/:file", () => {
  const FILE = "0123456789abcdef0123456789abcdef.png";

  // Every one of these is refused on its shape, before the store is asked —
  // which is what keeps a request from steering a read anywhere else in it.
  it("refuses anything that is not exactly a name it would have generated", async () => {
    const { app } = appWith();
    const paths = [
      `/avatars/${USER_ID}/..%2F..%2Fsecret.png`,
      `/avatars/..%2F${USER_ID}/${FILE}`,
      `/avatars/${USER_ID.toUpperCase()}/${FILE}`,
      `/avatars/${USER_ID}/x.svg`,
      `/avatars/${USER_ID}/0123456789abcdef0123456789abcde.png`,
      `/avatars/${USER_ID}/0123456789abcdef0123456789abcdef.svg`,
      `/avatars/not-a-uuid/${FILE}`,
    ];

    for (const path of paths) {
      expect((await app.request(path)).status, path).toBe(404);
    }
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("answers 404 for a photo that is not there", async () => {
    const { app } = appWith();

    expect((await app.request(`/avatars/${USER_ID}/${FILE}`)).status).toBe(404);
    expect(storeGet).toHaveBeenCalledWith(`avatars/${USER_ID}/${FILE}`);
  });

  it("serves a stored photo as an image that nothing can run inside", async () => {
    const { app } = appWith();
    stored.set(`avatars/${USER_ID}/${FILE}`, { bytes: PNG.buffer, contentType: "image/png" });

    const res = await app.request(`/avatars/${USER_ID}/${FILE}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("names the type from the extension, not from what the store recorded", async () => {
    const { app } = appWith();
    const webp = FILE.replace(".png", ".webp");
    stored.set(`avatars/${USER_ID}/${webp}`, { bytes: PNG.buffer, contentType: "text/html" });

    const res = await app.request(`/avatars/${USER_ID}/${webp}`);

    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });
});
