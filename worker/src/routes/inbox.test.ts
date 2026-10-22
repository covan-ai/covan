import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { inbox, mapInboxRow, plainLine, sumCounts } from "./inbox";

/**
 * The Inbox route, where it is more than a pass-through: what it asks the
 * database for, and what the one line under each title ends up saying.
 * Who may see which thread is `inbox_rows`' business, and that is held by the
 * policies it runs under (tests/rls/inbox.test.ts).
 */

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "mina@acme.test" };
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const row = (over: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  agent_id: AGENT,
  title: "Refund policy for EU orders",
  kind: "chat",
  visibility: "private",
  owner_id: USER.id,
  owner_name: "Mina Kaya",
  last_activity_at: "2026-10-22T09:00:00Z",
  preview_role: "assistant",
  preview_sender_id: null,
  preview_sender_name: "Support",
  preview_text: "## Yes\n\nWith **one** condition.",
  preview_at: "2026-10-22T09:00:00Z",
  unread_count: 1,
  needs_kind: null,
  needs_paused_turn_id: null,
  needs_summary: null,
  needs_replies: null,
  needs_since: null,
  running_steps: null,
  running_tool: null,
  running_note: null,
  running_since: null,
  ...over,
});

function appWith(spec: FakeDbSpec) {
  const fake = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE), ...spec.tables },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", inbox);
  return { app, ...fake };
}

describe("GET /inbox", () => {
  it("asks for one page more than it shows, and says there is more", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const { app } = appWith({
      rpc: {
        inbox_rows: (args) => {
          asked.push(args);
          return { data: [row(), row({ session_id: "s2" })], error: null };
        },
        inbox_counts: () => ({
          data: [{ agent_id: AGENT, unread: 3, needs_you: 2, running: 1 }],
          error: null,
        }),
      },
    });

    const res = await app.request(`/inbox?filter=needs_you&agent=${AGENT}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(asked[0]).toMatchObject({
      p_workspace_id: WORKSPACE,
      p_filter: "needs_you",
      p_agent_id: AGENT,
      p_limit: 2,
    });
    expect((body.items as unknown[]).length).toBe(1);
    expect(body.hasMore).toBe(true);
    expect(body.counts).toEqual({ unread: 3, needsYou: 2, running: 1 });
    expect(body.perAgentUnread).toEqual({ [AGENT]: 3 });
  });

  it("refuses a filter it does not know", async () => {
    const { app } = appWith({});
    expect((await app.request("/inbox?filter=everything")).status).toBe(400);
  });
});

describe("the line under a title", () => {
  it("is the newest message with its Markdown taken off", () => {
    const item = mapInboxRow(row() as never, USER.id);
    expect(item.preview).toMatchObject({ senderName: "Support", text: "Yes With one condition." });
    expect(item.unread).toBe(true);
    expect(item.sharedBy).toBeNull();
  });

  it("is the question, when the reply asked one", () => {
    const item = mapInboxRow(
      row({
        needs_kind: "question",
        needs_summary: "Draft the reply, or is the summary enough?",
        needs_replies: ["Draft the reply", "Summary is enough"],
        needs_since: "2026-10-22T09:00:00Z",
      }) as never,
      USER.id,
    );
    expect(item.preview?.text).toBe("Draft the reply, or is the summary enough?");
    expect(item.needsYou).toEqual({
      kind: "question",
      summary: "Draft the reply, or is the summary enough?",
      replies: ["Draft the reply", "Summary is enough"],
      since: Date.parse("2026-10-22T09:00:00Z"),
    });
  });

  it("is the step, while a turn is running", () => {
    const item = mapInboxRow(
      row({
        running_steps: 3,
        running_tool: "read_pages",
        running_note: "Reading 6 pages",
        running_since: "2026-10-22T08:56:00Z",
      }) as never,
      USER.id,
    );
    expect(item.preview?.text).toBe("Reading 6 pages");
    expect(item.running).toMatchObject({ stepsDone: 3, note: "Reading 6 pages" });
  });

  it("names who shared somebody else's thread, and the sign-in a browser run hit", () => {
    const item = mapInboxRow(
      row({
        owner_id: "someone-else",
        owner_name: "Can B.",
        visibility: "shared",
        needs_kind: "login",
        needs_summary: "linkedin.com",
      }) as never,
      USER.id,
    );
    expect(item.sharedBy).toBe("Can B.");
    expect(item.needsYou?.summary).toBe("Needs you to sign in to linkedin.com");
  });
});

describe("plainLine", () => {
  it("folds a reply into one readable line", () => {
    expect(plainLine("- **Window:** 30 days\n- [Policy](https://x.test)")).toBe(
      "Window: 30 days Policy",
    );
    expect(plainLine("a".repeat(300), 10)).toBe("aaaaaaaaa…");
  });
});

describe("counts", () => {
  it("adds the agents up and keeps each one for the sidebar", () => {
    expect(
      sumCounts([
        { agent_id: "a", unread: 2, needs_you: 1, running: 0 },
        { agent_id: "b", unread: 1, needs_you: 0, running: 1 },
      ]),
    ).toEqual({
      unread: 3,
      needsYou: 1,
      running: 1,
      byAgent: {
        a: { unread: 2, needsYou: 1, running: 0 },
        b: { unread: 1, needsYou: 0, running: 1 },
      },
    });
  });
});

describe("POST /inbox/read", () => {
  it("marks a thread the caller can see, as them", async () => {
    const { app, callsTo } = appWith({
      tables: {
        chat_sessions: {
          select: () => ({ data: { id: SESSION, workspace_id: WORKSPACE }, error: null }),
        },
        session_reads: { insert: () => ({ data: null, error: null }) },
      },
    });
    const res = await app.request("/inbox/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION }),
    });
    expect(res.status).toBe(200);
    expect(callsTo("session_reads")[0]!.values).toMatchObject({
      session_id: SESSION,
      user_id: USER.id,
      workspace_id: WORKSPACE,
    });
  });

  it("answers a thread the caller cannot see as not there", async () => {
    const { app, callsTo } = appWith({
      tables: { chat_sessions: { select: () => ({ data: null, error: null }) } },
    });
    const res = await app.request("/inbox/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION }),
    });
    expect(res.status).toBe(404);
    expect(callsTo("session_reads")).toEqual([]);
  });
});

describe("POST /inbox/read-all", () => {
  it("marks every thread in the caller's workspace in one call", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const { app } = appWith({
      rpc: {
        mark_all_sessions_read: (args) => {
          asked.push(args);
          return { data: 7, error: null };
        },
      },
    });
    const res = await app.request("/inbox/read-all", { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, marked: 7 });
    expect(asked).toEqual([{ p_workspace_id: WORKSPACE }]);
  });
});
