import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { CompletionRequest, CompletionUsage } from "../completion";

const complete = vi.fn(
  async (
    _env: unknown,
    _req: CompletionRequest,
    _opts?: { signal?: AbortSignal },
  ): Promise<{ text: string; usage: CompletionUsage; finishReason: string | null }> => ({
    text: "Example.com lists three tiers: Starter at $29/mo, Pro at $99/mo, and Enterprise on request.",
    usage: { promptTokens: 300, completionTokens: 40 } as CompletionUsage,
    finishReason: "stop",
  }),
);
vi.mock("../completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../completion")>();
  return {
    ...actual,
    complete: (env: unknown, req: CompletionRequest, opts?: { signal?: AbortSignal }) =>
      complete(env, req, opts),
  };
});

const deliverFn = vi.fn(async (): Promise<void> => {});
vi.mock("../routines/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routines/delivery")>();
  return {
    ...actual,
    deliver: () => deliverFn(),
    deliveryDepsFrom: () => ({}) as ReturnType<typeof actual.deliveryDepsFrom>,
  };
});

const record = vi.fn(async (): Promise<void> => {});
vi.mock("../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entitlements")>();
  return { ...actual, entitlementsFor: () => ({ record: () => record() }) };
});

import { deliverBrowserTask } from "./deliver";
import type { BrowserTaskRow, FinishedTask } from "./poller";

const ENV = {
  BROWSER_USE_API_KEY: "bu_test",
  OPENAI_API_KEY: "sk-test",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <x@example.com>",
  ROUTINE_SECRET_KEY: "k",
} as RoutineEnv;

const ROW: BrowserTaskRow = {
  id: "bt-1",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "sess-1",
  provider_task_id: "bu-1",
  task: "read the pricing table on example.com and list the tiers",
  status: "finished",
  poll_count: 2,
};

const FINISHED: FinishedTask = {
  status: "finished",
  output: "Starter $29/mo, Pro $99/mo, Enterprise on request",
  error: null,
  costUsd: 0.21,
};

let agentRow: Record<string, unknown> | null;
let channelRow: Record<string, unknown> | null;
let sessionExists: boolean;
let inserted: Record<string, unknown>[];
let messageInsertFails: boolean;

function fakeDb(): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "agents") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: agentRow, error: null }) }),
          }),
        };
      }
      if (table === "chat_sessions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: sessionExists ? { id: "sess-1" } : null,
                error: null,
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "delivery_channels") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle: async () => ({ data: channelRow, error: null }) }),
              }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          insert: (rowIn: Record<string, unknown>) => {
            inserted.push(rowIn);
            return {
              select: () => ({
                single: async () =>
                  messageInsertFails
                    ? { data: null, error: { message: "insert failed" } }
                    : { data: { id: "msg-1" }, error: null },
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  agentRow = { model: "gpt-4.1", temperature: 0.4, reasoning_effort: null };
  channelRow = { id: "ch-1", kind: "email", secret_ciphertext: "v1.x" };
  sessionExists = true;
  inserted = [];
  messageInsertFails = false;
  complete.mockReset();
  complete.mockResolvedValue({
    text: "Example.com lists three tiers: Starter at $29/mo, Pro at $99/mo, and Enterprise on request.",
    usage: { promptTokens: 300, completionTokens: 40 } as CompletionUsage,
    finishReason: "stop",
  });
  deliverFn.mockReset();
  record.mockReset();
});

describe("a finished task", () => {
  it("writes the answer into the conversation as a new assistant message", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      session_id: "sess-1",
      role: "assistant",
      sender_id: null,
      outcome: "answered",
    });
    expect(String(inserted[0].content)).toContain("Starter at $29/mo");
  });

  /**
   * One model call, with no tools. The browser already did the work; this is
   * phrasing, not reasoning, and a tool loop here would be a second agent
   * turn nobody asked for running on a cron Worker's subrequest budget.
   */
  it("makes exactly one model call and gives it no tools", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(request.tools).toBeUndefined();
    expect(request.model).toBe("gpt-4.1");
  });

  it("shows the model what was asked and what came back", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    const request = complete.mock.calls[0][1];
    const prompt = request.messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain(ROW.task);
    expect(prompt).toContain(FINISHED.output as string);
  });

  /**
   * Bookkeeping on the row, not a second charge. The 137,000 tokens taken
   * when the task was created already stand for $0.17, which dwarfs one small
   * completion — charging the allowance again here would bill twice for one
   * piece of work.
   */
  it("records what the phrasing call cost without charging the allowance again", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0]).toMatchObject({ prompt_tokens: 300, completion_tokens: 40 });
    expect(record).not.toHaveBeenCalled();
  });

  it("notifies the person through their delivery channel", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(deliverFn).toHaveBeenCalledTimes(1);
  });

  it("still writes the message when the person has no delivery channel", async () => {
    channelRow = null;
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("still writes the message when the notification fails", async () => {
    deliverFn.mockRejectedValue(new Error("channel dead"));
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
  });
});

describe("a task that did not work", () => {
  it("says what stopped it, using the browser's own sentence", async () => {
    const failed: FinishedTask = {
      status: "failed",
      output: "The page asked me to sign in.",
      error: null,
      costUsd: 0.08,
    };
    await deliverBrowserTask(ROW, failed, ENV, fakeDb());
    const prompt = complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("The page asked me to sign in.");
    expect(inserted).toHaveLength(1);
  });

  /**
   * No model call when there is nothing for it to phrase. Paying for a
   * completion to turn "it was given up on" into a sentence is paying twice
   * for a failure.
   */
  it("writes a plain sentence with no model call when there is no output at all", async () => {
    const stopped: FinishedTask = {
      status: "stopped",
      output: null,
      error: "this took too long and was given up on",
      costUsd: 0.4,
    };
    await deliverBrowserTask(ROW, stopped, ENV, fakeDb());
    expect(complete).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0].content)).toContain("given up on");
    expect(String(inserted[0].content)).toContain(ROW.task);
  });
});

describe("when the ground has moved", () => {
  /**
   * `browser_tasks.session_id` cascades, so deleting the conversation deletes
   * the row — but a browser already running at the provider carries on. The
   * poller can therefore reach here for a session that is gone.
   */
  it("does nothing and does not throw when the conversation has been deleted", async () => {
    sessionExists = false;
    await expect(deliverBrowserTask(ROW, FINISHED, ENV, fakeDb())).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back to the deployment's model when the agent has gone", async () => {
    agentRow = null;
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(complete).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
  });

  it("does not throw when the model call fails — the output is still worth delivering", async () => {
    complete.mockRejectedValue(new Error("provider down"));
    await expect(deliverBrowserTask(ROW, FINISHED, ENV, fakeDb())).resolves.toBeUndefined();
    expect(inserted).toHaveLength(1);
    // The raw output, rather than nothing.
    expect(String(inserted[0].content)).toContain("Starter $29/mo");
  });

  it("does not throw when the message cannot be written", async () => {
    messageInsertFails = true;
    await expect(deliverBrowserTask(ROW, FINISHED, ENV, fakeDb())).resolves.toBeUndefined();
  });
});
