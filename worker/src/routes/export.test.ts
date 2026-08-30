import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { exportRoutes } from "./export";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { EXPORTED } from "../lib/export/tables";

/**
 * The workspace export, at the seam where it decides what it is allowed to
 * build.
 *
 * What the archive contains is `lib/export/`'s business and is tested there.
 * What matters here is narrower and easier to get wrong: that a stranger gets a
 * 404 rather than an empty archive, that every read is scoped and paged, and
 * that a failure part-way through the collection is still a status code —
 * because once the first byte of a zip is on the wire the only way left to
 * report a problem is to truncate the download, which looks exactly like a
 * dropped connection.
 */

const USER = { id: "user-1", email: "a@example.com" };
const WORKSPACE = "ws-1";

const docs = { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() };
vi.mock("../lib/docstore", () => ({ getDocStore: () => docs }));

/**
 * Answers every export read with nothing, except where a test says otherwise.
 *
 * Built from `EXPORTED` rather than listed by hand, so a table added to the
 * export arrives here already stubbed — the alternative is a suite that fails
 * with "unexpected table" for a change that was correct.
 */
function appWith(spec: FakeDbSpec = {}) {
  const empty = () => ({ data: [], error: null });
  const tables: FakeDbSpec["tables"] = Object.fromEntries(
    EXPORTED.map((t) => [t.table, { select: empty }]),
  );

  Object.assign(tables, {
    workspace_members: {
      select: (ctx: QueryContext) =>
        // The membership check ends in maybeSingle(); the paged read does not.
        ctx.single ? { data: { role: "admin" }, error: null } : empty(),
    },
    workspaces: {
      select: (ctx: QueryContext) =>
        ctx.single
          ? { data: { id: WORKSPACE, name: "Acme", slug: "acme" }, error: null }
          : { data: [{ id: WORKSPACE, name: "Acme", slug: "acme" }], error: null },
    },
    ...spec.tables,
  });

  const fake = fakeDb({ ...spec, tables });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", exportRoutes);
  return { app, ...fake };
}

const get = (app: Hono<AppEnv>, id = WORKSPACE) => app.request(`/workspaces/${id}/export`);

describe("who may take one", () => {
  it("hands a member an archive", async () => {
    const { app } = appWith();
    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  it("answers a stranger with 404, not with an empty archive", async () => {
    // Not 403: an archive of nothing would imply the workspace exists and holds
    // nothing, and a 403 would confirm it exists at all.
    const { app } = appWith({
      tables: { workspace_members: { select: () => ({ data: null, error: null }) } },
    });

    const res = await get(app);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("names the workspace in the filename, so two exports are tellable apart", async () => {
    const { app } = appWith();
    const disposition = (await get(app)).headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(decodeURIComponent(disposition)).toMatch(/covan-acme-\d{4}-\d{2}-\d{2}\.zip/);
  });

  it("is never cached — it is one person's data with their name on it", async () => {
    const { app } = appWith();
    expect((await get(app)).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("how it reads", () => {
  it("scopes every read to the workspace, and pages all of them", async () => {
    const { app, calls } = appWith();
    await get(app);

    const paged = calls.filter((c) => c.range);
    expect(paged.length).toBeGreaterThan(5);
    for (const call of paged) {
      expect(call.range, `${call.table} was read without a range`).toBeDefined();
    }
  });

  it("starts at the workspace and its members, which everything else hangs off", async () => {
    const { app, calls } = appWith();
    await get(app);

    const read = calls.filter((c) => c.range).map((c) => c.table);
    expect(read.slice(0, 2)).toEqual(["workspaces", "workspace_members"]);
  });

  it("carries a parent's ids into the tables scoped by them", async () => {
    // The step that makes the archive complete rather than merely non-empty:
    // messages are not workspace-scoped, they are session-scoped, and the only
    // way to find them is the id list the previous read produced.
    const { app, calls } = appWith({
      tables: {
        chat_sessions: {
          select: () => ({
            data: [
              { id: "s1", workspace_id: WORKSPACE },
              { id: "s2", workspace_id: WORKSPACE },
            ],
            error: null,
          }),
        },
      },
    });
    await get(app);

    const messages = calls.find((c) => c.table === "messages");
    expect(messages?.filters).toEqual([{ column: "session_id", value: ["s1", "s2"], kind: "in" }]);
  });

  it("never asks for delivery_channels' secret column", async () => {
    // 0023 withheld it from `authenticated`, and PostgREST expands `*` to every
    // column — so a `select *` here is a 42501 for the whole table rather than
    // a row with one field missing.
    const { app, calls } = appWith();
    await get(app);

    const channels = calls.find((c) => c.table === "delivery_channels");
    expect(channels?.columns).toBeDefined();
    expect(channels?.columns).not.toContain("secret_ciphertext");
  });

  it("skips a dependent table when its parent came back empty", async () => {
    // No bundles means no documents to look for, and an `in ()` with no values
    // is a query worth not sending.
    const { app, calls } = appWith();
    await get(app);

    expect(calls.some((c) => c.table === "knowledge_bundles")).toBe(true);
    expect(calls.some((c) => c.table === "documents")).toBe(false);
  });
});

describe("when a read fails", () => {
  it("answers with a status code rather than a truncated download", async () => {
    const { app } = appWith({
      tables: { agents: { select: () => ({ data: null, error: { message: "boom" } }) } },
    });

    const res = await get(app);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to read agents" });
  });

  it("reports a failure in a dependent table too, naming that table", async () => {
    // Not the same path: this one fails after several successful reads, deep in
    // the id-threading, which is where a partial archive would otherwise be
    // easiest to emit.
    const { app } = appWith({
      tables: {
        chat_sessions: {
          select: () => ({ data: [{ id: "s1", workspace_id: WORKSPACE }], error: null }),
        },
        messages: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });

    const res = await get(app);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to read messages" });
  });
});
