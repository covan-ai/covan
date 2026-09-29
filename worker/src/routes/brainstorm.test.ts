import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { HISTORY_CHAR_BUDGET, PER_MESSAGE_CHAR_CAP } from "../lib/history";
import { brainstorm, EXTRACT_MSG_LIMIT } from "./brainstorm";

/**
 * The brainstorm route's first test, and what it is for.
 *
 * This file went untested for as long as it was a pass-through: it read thirty
 * rows, joined them, and handed the string to the model. On 2026-09-29 (#227) it
 * stopped being a pass-through — the join now goes through `selectHistory` on
 * two character budgets, because a row count is not a bound on a prompt
 * (`routes/messages.ts` validates content as `z.string().min(1)`, no maximum, so
 * thirty rows is thirty times whatever somebody pasted).
 *
 * `lib/history.test.ts` proves `selectHistory` truncates. It cannot prove this
 * route calls it, on which budgets, or that what survives the cut is still a
 * conversation the extractor can read. That is what is below. #231.
 *
 * `selectHistory` is deliberately NOT stubbed — the real trimming runs, the same
 * call `reports.test.ts` makes for `chunkText`. The spy only records the options
 * it was handed, so a route that silently changed budget fails here by name
 * rather than by a character count nobody would recognise.
 */

const USER = { id: "user-1", email: "a@example.com" };
const SESSION = { agent_id: "agent-1" };

const completionCreate = vi.fn();
const guardQuota = vi.fn();
const recordQuota = vi.fn();
const selectHistoryOptions = vi.fn();

vi.mock("../lib/openai", () => ({
  createOpenAI: () => ({ chat: { completions: { create: completionCreate } } }),
}));

vi.mock("../lib/anthropic", () => ({
  createAnthropic: () => ({ messages: { create: vi.fn() } }),
}));

vi.mock("../lib/entitlements/guard", () => ({
  guardQuota: (...args: unknown[]) => guardQuota(...args),
  recordQuota: (...args: unknown[]) => recordQuota(...args),
}));

vi.mock("../lib/history", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/history")>();
  return {
    ...real,
    selectHistory: (rows: Parameters<typeof real.selectHistory>[0], options?: unknown) => {
      selectHistoryOptions(options);
      return real.selectHistory(rows, options as Parameters<typeof real.selectHistory>[1]);
    },
  };
});

/**
 * One message, numbered so the transcript can be read back in order.
 *
 * The marker leads the content because `selectHistory` keeps the HEAD of an
 * over-cap message — a marker at the tail would be cut off by the very
 * truncation these tests are about, and every ordering assertion would pass
 * vacuously against an empty set of markers.
 */
function message(n: number, chars: number) {
  const marker = `[[m${String(n).padStart(2, "0")}]]`;
  return {
    role: n % 2 === 1 ? "user" : "assistant",
    content: `${marker} ${"x".repeat(Math.max(0, chars - marker.length - 1))}`,
    created_at: `2026-09-01T10:${String(n).padStart(2, "0")}:00.000Z`,
  };
}

/** `count` messages of `chars` each, newest first — the order the route reads. */
function conversation(count: number, chars: number) {
  return Array.from({ length: count }, (_, i) => message(i + 1, chars)).reverse();
}

function appWith(rows: unknown[], spec?: Partial<FakeDbSpec["tables"]>) {
  const fake = fakeDb({
    tables: {
      chat_sessions: { select: () => ({ data: SESSION, error: null }) },
      agents: { select: () => ({ data: { model: null }, error: null }) },
      messages: { select: () => ({ data: rows, error: null }) },
      ...spec,
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", brainstorm);
  return { app, fake };
}

const suggest = (app: Hono<AppEnv>, body: unknown = { sessionId: "sess-1" }) =>
  app.request(
    "/brainstorm/ideas/suggest",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    { OPENAI_API_KEY: "sk-test" },
  );

/** The transcript the extractor actually received, labels and all. */
function transcriptSent(): string {
  const body = completionCreate.mock.calls.at(-1)?.[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  const user = body.messages.find((m) => m.role === "user");
  return (user?.content ?? "").replace("Conversation so far:\n\n", "");
}

/** The message numbers that survived, in the order the model reads them. */
function markersSent(): number[] {
  return [...transcriptSent().matchAll(/\[\[m(\d\d)\]\]/g)].map((m) => Number(m[1]));
}

beforeEach(() => {
  vi.clearAllMocks();
  guardQuota.mockResolvedValue(null);
  recordQuota.mockResolvedValue(undefined);
  completionCreate.mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            ideas: [
              { title: "Weekly digest", detail: "Mail the team what changed." },
              { title: "Drop step three", detail: "Nobody finishes onboarding." },
            ],
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 9000, completion_tokens: 240 },
  });
});

describe("POST /brainstorm/ideas/suggest", () => {
  it("reads the newest page of messages and hands it over oldest-first", async () => {
    const { app, fake } = appWith(conversation(4, 40));
    const res = await suggest(app);
    expect(res.status).toBe(200);

    const read = fake.callsTo("messages").at(-1);
    expect(read?.order).toEqual([{ column: "created_at", ascending: false }]);
    expect(read?.limit).toBe(EXTRACT_MSG_LIMIT);

    // Read newest-first, sent oldest-first: idea extraction reads the
    // conversation as a narrative, so the reversal is not cosmetic.
    expect(markersSent()).toEqual([1, 2, 3, 4]);
    expect(transcriptSent().startsWith("User: [[m01]]")).toBe(true);
    expect(transcriptSent()).toContain("\nAgent: [[m02]]");
  });

  it("returns no ideas, and spends nothing, on a conversation with no messages", async () => {
    const { app } = appWith([]);
    const res = await suggest(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideas: [] });
    expect(completionCreate).not.toHaveBeenCalled();
    expect(recordQuota).not.toHaveBeenCalled();
  });
});

describe("what a long brainstorm sends", () => {
  /** Thirty messages of 8,000 chars: 240,000 characters before #227 bounded it. */
  const HUGE = 30;
  const EACH = 8000;

  it("bounds the transcript on both character budgets, not on the row count", async () => {
    const { app } = appWith(conversation(HUGE, EACH));
    await suggest(app);

    expect(selectHistoryOptions).toHaveBeenCalledWith({
      maxChars: HISTORY_CHAR_BUDGET,
      perMessageCap: PER_MESSAGE_CHAR_CAP,
    });

    // The labels and newlines the route adds are not the model's history, so
    // they are subtracted before the budget is checked.
    const lines = transcriptSent().split("\n");
    const overhead =
      lines.reduce((n, line) => n + (line.startsWith("Agent: ") ? 7 : 6), 0) + (lines.length - 1);
    expect(transcriptSent().length - overhead).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);

    // And the number that matters: the row count alone would have sent this.
    expect(transcriptSent().length).toBeLessThan(HUGE * EACH);
  });

  it("still produces cards when the conversation is far over the budget", async () => {
    const { app } = appWith(conversation(HUGE, EACH));
    const res = await suggest(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ideas: [
        { title: "Weekly digest", detail: "Mail the team what changed." },
        { title: "Drop step three", detail: "Nobody finishes onboarding." },
      ],
    });
    expect(recordQuota).toHaveBeenCalledWith(expect.anything(), 9240);
  });

  it("keeps oldest-first order after the budget cuts the transcript", async () => {
    const { app } = appWith(conversation(HUGE, EACH));
    await suggest(app);

    const sent = markersSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(HUGE);
    // Ascending, and it is the OLDEST end that was dropped: what the extractor
    // reads must still run forwards and must still reach the latest turn.
    expect([...sent].sort((a, b) => a - b)).toEqual(sent);
    expect(sent.at(-1)).toBe(HUGE);
    expect(sent).not.toContain(1);
  });

  it("caps one giant paste instead of dropping the turns around it", async () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => message(i + 1, 60)),
      message(5, PER_MESSAGE_CHAR_CAP * 3),
      ...Array.from({ length: 3 }, (_, i) => message(i + 6, 60)),
    ].reverse();
    const { app } = appWith(rows);
    await suggest(app);

    // Every turn survives — the paste is trimmed, not the conversation.
    expect(markersSent()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // And the model is told the paste was cut rather than left to believe it
    // ended where the cap fell.
    expect(transcriptSent()).toContain("…[truncated]");
    const paste = transcriptSent().split("\n")[4];
    expect(paste.length).toBeLessThanOrEqual(PER_MESSAGE_CHAR_CAP + "User: ".length);
  });
});

describe("what the route refuses", () => {
  it("answers 400 when the body names no session", async () => {
    const { app } = appWith(conversation(2, 40));
    const res = await suggest(app, {});

    expect(res.status).toBe(400);
    expect(completionCreate).not.toHaveBeenCalled();
  });

  it("answers 404 for a conversation the caller cannot see", async () => {
    const { app } = appWith(conversation(2, 40), {
      chat_sessions: { select: () => ({ data: null, error: null }) },
    });
    const res = await suggest(app);

    expect(res.status).toBe(404);
    expect(completionCreate).not.toHaveBeenCalled();
  });

  it("answers 500 rather than an empty brainstorm when the messages fail to load", async () => {
    const { app } = appWith([], {
      messages: { select: () => ({ data: null, error: { message: "boom" } }) },
    });
    const res = await suggest(app);

    // The distinction that matters: a failed read is not an empty conversation,
    // and the `{ ideas: [] }` above would have been indistinguishable from one.
    expect(res.status).toBe(500);
    expect(completionCreate).not.toHaveBeenCalled();
  });

  it("spends nothing when the quota has already been refused", async () => {
    const { app } = appWith(conversation(4, 40));
    guardQuota.mockResolvedValue(new Response("over", { status: 402 }));
    const res = await suggest(app);

    expect(res.status).toBe(402);
    expect(completionCreate).not.toHaveBeenCalled();
    expect(recordQuota).not.toHaveBeenCalled();
  });
});
