import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import {
  activeWorkspaceTables,
  fakeDb,
  type QueryContext,
  type QueryResult,
} from "../test-support/fake-db";
import { MAX_OWNER_NOTES, MAX_WORKSPACE_NOTES, NOTE_CHARS } from "../lib/harness/tools/remember";
import { memory } from "./memory";

const USER = { id: "user-1", email: "ada@acme.test" };
const WS = "ws-1";
const ID = "5b0e6a3e-3f0e-4c4e-9c44-0f6b1d2a7a10";

type Row = Record<string, unknown>;

function row(over: Row = {}): Row {
  return {
    id: ID,
    about: "team",
    scope: "workspace",
    text: "Invoices go out on the first working day.",
    source: "person",
    created_by: USER.id,
    source_session_id: "session-9",
    created_at: "2026-10-25T08:00:00.000Z",
    updated_at: "2026-10-25T08:00:00.000Z",
    ...over,
  };
}

type Spec = {
  list?: Row[];
  /** What the count of notes in the scope about to be joined answers. */
  count?: number;
  canWrite?: boolean | null;
  insert?: QueryResult;
  update?: QueryResult;
  delete?: QueryResult;
};

function setup(spec: Spec = {}) {
  const { db, calls, callsTo } = fakeDb({
    tables: {
      ...activeWorkspaceTables(USER.id, WS),
      memory_notes: {
        select: (ctx: QueryContext) =>
          ctx.order
            ? { data: spec.list ?? [], error: null }
            : { data: null, error: null, count: spec.count ?? 0 },
        insert: () => spec.insert ?? { data: row(), error: null },
        update: () => spec.update ?? { data: [row()], error: null },
        delete: () => spec.delete ?? { data: [{ id: ID }], error: null },
      },
    },
    rpc: {
      can_write_in_workspace: () => ({ data: spec.canWrite ?? true, error: null }),
    },
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", USER as never);
    await next();
  });
  app.route("/", memory);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { send, calls, notes: () => callsTo("memory_notes") };
}

describe("GET /memory", () => {
  it("lists the workspace's notes, newest first, with `mine` read from the author", async () => {
    const { send, notes } = setup({
      list: [
        row({ id: "b", created_by: "user-2", created_at: "2026-10-25T09:00:00.000Z" }),
        row({ id: "a", about: "person", scope: "owner", source: "agent" }),
      ],
    });

    const res = await send("GET", "/memory");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: Array<Record<string, unknown>> };
    expect(body.notes).toEqual([
      {
        id: "b",
        about: "team",
        scope: "workspace",
        text: "Invoices go out on the first working day.",
        source: "person",
        mine: false,
        createdAt: Date.parse("2026-10-25T09:00:00.000Z"),
      },
      {
        id: "a",
        about: "person",
        scope: "owner",
        text: "Invoices go out on the first working day.",
        source: "agent",
        mine: true,
        createdAt: Date.parse("2026-10-25T08:00:00.000Z"),
      },
    ]);

    const q = notes()[0];
    expect(q.filters).toContainEqual({ column: "workspace_id", value: WS, kind: "eq" });
    expect(q.order).toEqual([
      { column: "created_at", ascending: false },
      { column: "id", ascending: false },
    ]);
  });

  it("never puts the author or the thread on the wire", async () => {
    const { send } = setup({ list: [row()] });
    const text = await (await send("GET", "/memory")).text();
    expect(text).not.toContain("created_by");
    expect(text).not.toContain("source_session_id");
    expect(text).not.toContain("session-9");
  });

  it("answers a read that fails with 500", async () => {
    const { db } = fakeDb({
      tables: {
        ...activeWorkspaceTables(USER.id, WS),
        memory_notes: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("user", USER as never);
      await next();
    });
    app.route("/", memory);
    expect((await app.request("/memory")).status).toBe(500);
  });
});

describe("POST /memory", () => {
  it("keeps a note about the team for everybody, as the person's own words", async () => {
    const { send, notes } = setup();

    const res = await send("POST", "/memory", {
      text: "  Invoices go out on the first working day.  ",
      about: "team",
    });

    expect(res.status).toBe(201);
    const insert = notes().find((c) => c.op === "insert")!;
    expect(insert.values).toEqual({
      workspace_id: WS,
      created_by: USER.id,
      about: "team",
      scope: "workspace",
      text: "Invoices go out on the first working day.",
      source: "person",
      source_session_id: null,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: ID, about: "team", scope: "workspace", mine: true });
    expect(body).not.toHaveProperty("created_by");
  });

  it("keeps a note about the person as theirs alone", async () => {
    const { send, notes } = setup({
      insert: { data: row({ about: "person", scope: "owner" }), error: null },
    });

    const res = await send("POST", "/memory", { text: "Short answers, please.", about: "person" });

    expect(res.status).toBe(201);
    expect(notes().find((c) => c.op === "insert")!.values).toMatchObject({
      about: "person",
      scope: "owner",
      source: "person",
      source_session_id: null,
    });
  });

  it("lets a viewer keep a note about themselves", async () => {
    const { send } = setup({
      canWrite: false,
      insert: { data: row({ about: "person", scope: "owner" }), error: null },
    });
    const res = await send("POST", "/memory", { text: "Short answers, please.", about: "person" });
    expect(res.status).toBe(201);
  });

  it("refuses a viewer a note for the team, before writing anything", async () => {
    const { send, notes } = setup({ canWrite: false });

    const res = await send("POST", "/memory", { text: "We use Notion.", about: "team" });

    expect(res.status).toBe(403);
    expect(notes().filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("answers 403 when the insert is refused by policy", async () => {
    const { send } = setup({
      insert: { data: null, error: { code: "42501", message: "new row violates policy" } },
    });
    const res = await send("POST", "/memory", { text: "We use Notion.", about: "team" });
    expect(res.status).toBe(403);
  });

  it("refuses a note over the limit with 400 and names the limit", async () => {
    const { send, notes } = setup();

    const res = await send("POST", "/memory", {
      text: "x".repeat(NOTE_CHARS + 1),
      about: "person",
    });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("280");
    expect(notes()).toHaveLength(0);
  });

  it("takes a note of exactly the limit", async () => {
    const { send } = setup();
    const res = await send("POST", "/memory", { text: "x".repeat(NOTE_CHARS), about: "person" });
    expect(res.status).toBe(201);
  });

  it("measures the limit after trimming", async () => {
    const { send } = setup();
    const res = await send("POST", "/memory", {
      text: ` ${"x".repeat(NOTE_CHARS)} `,
      about: "person",
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ["an empty note", { text: "   ", about: "team" }],
    ["no text", { about: "team" }],
    ["an unknown subject", { text: "hi", about: "world" }],
    ["no subject", { text: "hi" }],
    ["a text that is not a string", { text: 4, about: "team" }],
  ])("refuses %s", async (_name, body) => {
    const { send } = setup();
    expect((await send("POST", "/memory", body)).status).toBe(400);
  });

  it("refuses a person's 101st note with 409, naming where to make room", async () => {
    const { send, notes } = setup({ count: MAX_OWNER_NOTES });

    const res = await send("POST", "/memory", { text: "One more.", about: "person" });

    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("Settings › Memory");
    expect(error).toContain(String(MAX_OWNER_NOTES));
    expect(notes().filter((c) => c.op === "insert")).toHaveLength(0);
    // Counted among this person's own notes in this workspace.
    const count = notes()[0];
    expect(count.filters).toEqual(
      expect.arrayContaining([
        { column: "workspace_id", value: WS, kind: "eq" },
        { column: "created_by", value: USER.id, kind: "eq" },
        { column: "scope", value: "owner", kind: "eq" },
      ]),
    );
  });

  it("refuses the workspace's 201st note with 409, counted across everybody", async () => {
    const { send, notes } = setup({ count: MAX_WORKSPACE_NOTES });

    const res = await send("POST", "/memory", { text: "One more.", about: "team" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(String(MAX_WORKSPACE_NOTES));
    const count = notes()[0];
    expect(count.filters.some((f) => f.column === "created_by")).toBe(false);
    expect(count.filters).toContainEqual({ column: "scope", value: "workspace", kind: "eq" });
  });

  it("answers a note already kept with 409 saying so", async () => {
    const { send } = setup({
      insert: { data: null, error: { code: "23505", message: "duplicate key" } },
    });
    const res = await send("POST", "/memory", { text: "We use Notion.", about: "team" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already noted/i);
  });

  it("answers any other failure with 500", async () => {
    const { send } = setup({ insert: { data: null, error: { message: "boom" } } });
    expect((await send("POST", "/memory", { text: "hi", about: "team" })).status).toBe(500);
  });
});

describe("PATCH /memory/:id", () => {
  it("changes the text, trimmed, and stamps the time on the server", async () => {
    const { send, notes } = setup();
    const before = Date.now();

    const res = await send("PATCH", `/memory/${ID}`, { text: "  Invoices go out on the 1st. " });

    expect(res.status).toBe(200);
    const update = notes().find((c) => c.op === "update")!;
    expect(Object.keys(update.values!).sort()).toEqual(["text", "updated_at"]);
    expect(update.values!.text).toBe("Invoices go out on the 1st.");
    const stamped = Date.parse(update.values!.updated_at as string);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { column: "id", value: ID, kind: "eq" },
        { column: "workspace_id", value: WS, kind: "eq" },
      ]),
    );
    expect(await res.json()).toMatchObject({ id: ID, mine: true });
  });

  it("shares a note with the team, counted against the workspace's room without itself", async () => {
    const { send, notes } = setup({ count: MAX_WORKSPACE_NOTES - 1 });

    const res = await send("PATCH", `/memory/${ID}`, { scope: "workspace" });

    expect(res.status).toBe(200);
    const update = notes().find((c) => c.op === "update")!;
    expect(Object.keys(update.values!).sort()).toEqual(["scope", "updated_at"]);
    expect(update.values!.scope).toBe("workspace");
    const count = notes()[0];
    expect(count.filters).toContainEqual({ column: "id", value: ID, kind: "neq" });
    expect(count.filters).toContainEqual({ column: "scope", value: "workspace", kind: "eq" });
  });

  it("refuses to share into a full workspace with 409", async () => {
    const { send, notes } = setup({ count: MAX_WORKSPACE_NOTES });
    const res = await send("PATCH", `/memory/${ID}`, { scope: "workspace" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Settings › Memory");
    expect(notes().filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("does not count the room when only the text changes", async () => {
    const { send, notes } = setup({ count: MAX_WORKSPACE_NOTES });
    const res = await send("PATCH", `/memory/${ID}`, { text: "Edited." });
    expect(res.status).toBe(200);
    expect(notes().filter((c) => !c.op || c.op === "select")).toHaveLength(0);
  });

  it("forwards both when both are sent", async () => {
    const { send, notes } = setup();
    await send("PATCH", `/memory/${ID}`, { text: "Edited.", scope: "workspace" });
    const update = notes().find((c) => c.op === "update")!;
    expect(Object.keys(update.values!).sort()).toEqual(["scope", "text", "updated_at"]);
  });

  it.each([
    ["an unknown key", { text: "ok", about: "team" }],
    ["the author", { created_by: "user-2" }],
    ["a scope that unshares", { scope: "owner" }],
    ["nothing at all", {}],
    ["an empty text", { text: "  " }],
    ["a text over the limit", { text: "x".repeat(NOTE_CHARS + 1) }],
  ])("refuses %s with 400 and writes nothing", async (_name, body) => {
    const { send, notes } = setup();
    const res = await send("PATCH", `/memory/${ID}`, body);
    expect(res.status).toBe(400);
    expect(notes()).toHaveLength(0);
  });

  it("names the limit when the text is too long", async () => {
    const { send } = setup();
    const res = await send("PATCH", `/memory/${ID}`, { text: "x".repeat(NOTE_CHARS + 1) });
    expect(((await res.json()) as { error: string }).error).toContain("280");
  });

  it("answers 404 when no row was changed, whether hidden or missing", async () => {
    const { send } = setup({ update: { data: [], error: null } });
    expect((await send("PATCH", `/memory/${ID}`, { text: "Edited." })).status).toBe(404);
  });

  it("answers 404 for an id that is not a uuid, without asking the database", async () => {
    const { send, notes } = setup();
    expect((await send("PATCH", "/memory/not-an-id", { text: "Edited." })).status).toBe(404);
    expect(notes()).toHaveLength(0);
  });

  it("answers 403 when the scope trigger or policy refuses", async () => {
    const { send } = setup({
      update: { data: null, error: { code: "42501", message: "only the person who wrote this" } },
    });
    expect((await send("PATCH", `/memory/${ID}`, { scope: "workspace" })).status).toBe(403);
  });

  it("answers 409 saying it is already noted when the new text collides", async () => {
    const { send } = setup({
      update: { data: null, error: { code: "23505", message: "duplicate key" } },
    });
    const res = await send("PATCH", `/memory/${ID}`, { text: "Edited." });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already noted/i);
  });

  it("refuses to share a note about a person", async () => {
    const { send } = setup({
      update: { data: null, error: { code: "23514", message: "person_is_private" } },
    });
    const res = await send("PATCH", `/memory/${ID}`, { scope: "workspace" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/person/i);
  });
});

describe("DELETE /memory/:id", () => {
  it("removes a note and answers 204", async () => {
    const { send, notes } = setup();

    const res = await send("DELETE", `/memory/${ID}`);

    expect(res.status).toBe(204);
    const del = notes().find((c) => c.op === "delete")!;
    expect(del.filters).toEqual(
      expect.arrayContaining([
        { column: "id", value: ID, kind: "eq" },
        { column: "workspace_id", value: WS, kind: "eq" },
      ]),
    );
  });

  it("answers 404, not 204, when the row is hidden by policy or missing", async () => {
    const { send } = setup({ delete: { data: [], error: null } });
    expect((await send("DELETE", `/memory/${ID}`)).status).toBe(404);
  });

  it("answers 404 for an id that is not a uuid", async () => {
    const { send, notes } = setup();
    expect((await send("DELETE", "/memory/nope")).status).toBe(404);
    expect(notes()).toHaveLength(0);
  });

  it("answers a failed delete with 500", async () => {
    const { send } = setup({ delete: { data: null, error: { message: "boom" } } });
    expect((await send("DELETE", `/memory/${ID}`)).status).toBe(500);
  });
});

describe("an API key", () => {
  // What a note says is read into agents' instructions long after the request,
  // so a key may read the list and may not change it.
  it("may read, and is refused every write", async () => {
    const { db, callsTo } = fakeDb({
      tables: {
        ...activeWorkspaceTables(USER.id, WS),
        memory_notes: { select: () => ({ data: [], error: null }) },
      },
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("user", USER as never);
      c.set("apiKeyId", "key-1" as never);
      c.set("apiKeyWorkspaceId", WS as never);
      await next();
    });
    app.route("/", memory);
    const call = (method: string, path: string) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body:
          method === "GET" || method === "DELETE"
            ? undefined
            : JSON.stringify({ text: "hi", about: "team" }),
      });

    expect((await call("GET", "/memory")).status).toBe(200);
    expect((await call("POST", "/memory")).status).toBe(403);
    expect((await call("PATCH", `/memory/${ID}`)).status).toBe(403);
    expect((await call("DELETE", `/memory/${ID}`)).status).toBe(403);
    expect(callsTo("memory_notes").filter((c) => c.op !== "select")).toHaveLength(0);
  });
});
