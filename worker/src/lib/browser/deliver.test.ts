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

const record = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({ record: (...args: unknown[]) => record(...args) }),
  };
});

/**
 * Whether a saved login was there to be used (Task 2.3), mocked because the
 * real one reads `browser_credentials` with the service role and
 * `credentials.test.ts` is where its rules are proved. False by default: the
 * ordinary login wall is a site nobody saved a login for.
 */
const hasSavedCredential = vi.fn(
  async (
    _env: unknown,
    _args: { agentId: string; userId: string; host: string },
    _overrides?: { db?: unknown },
  ): Promise<boolean> => false,
);
/** Whether the login a run carried was for the walled host (R32). False by default. */
const credentialCoversHost = vi.fn(
  async (
    _env: unknown,
    _args: { credentialId: string; host: string },
    _overrides?: { db?: unknown },
  ): Promise<boolean> => false,
);
vi.mock("./credentials", () => ({
  hasSavedCredential: (
    env: unknown,
    args: { agentId: string; userId: string; host: string },
    overrides?: { db?: unknown },
  ) => hasSavedCredential(env, args, overrides),
  credentialCoversHost: (
    env: unknown,
    args: { credentialId: string; host: string },
    overrides?: { db?: unknown },
  ) => credentialCoversHost(env, args, overrides),
}));

const completeHeldRun = vi.fn(async (..._args: unknown[]): Promise<boolean> => true);
vi.mock("../routines/held", () => ({
  completeHeldRun: (...args: unknown[]) => completeHeldRun(...args),
}));

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
/** The person's last message, as `theirWords` reads it; a string, null for none, or an Error to fail the read. */
let theirLast: string | null | Error;
/**
 * The person's messages with their times, when a test cares which one is
 * read: the fake applies `lte` and returns the latest left. Null uses `theirLast`.
 */
let said: { content: string; created_at: string }[] | null;
/** The `created_at` bound `theirWords` asked for, if any. */
let bound: string | undefined;
/** `browser_tasks` rows `askedAt` can read, by id; an Error fails the read. */
let tasks: Record<string, { created_at: string }> | Error;
/** What was written back to `browser_tasks`: `delivered_at` (0117). */
let marked: Array<Record<string, unknown>>;
/** Whether another task of the conversation is still waiting, queued or running (0142). */
let waitingInLine: boolean;

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
              is: () => ({
                order: () => ({
                  limit: () => ({ maybeSingle: async () => ({ data: channelRow, error: null }) }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "browser_tasks") {
        let id = "";
        const read = {
          eq: (_column: string, value: string) => {
            id = value;
            return read;
          },
          // The line read (0142): whether another task of the conversation is
          // still to come, which decides whether the step after this one can
          // be claimed soon.
          in: () => read,
          limit: async () => ({
            data: waitingInLine ? [{ id: "bt-waiting" }] : [],
            error: null,
          }),
          maybeSingle: async () =>
            tasks instanceof Error
              ? { data: null, error: { message: tasks.message } }
              : { data: tasks[id] ?? null, error: null },
        };
        return {
          select: () => read,
          update: (patch: Record<string, unknown>) => ({
            eq: async (_column: string, value: string) => {
              marked.push({ id: value, ...patch });
              return { error: null };
            },
          }),
        };
      }
      if (table === "messages") {
        const read = {
          eq: () => read,
          is: () => read,
          lte: (_column: string, value: string) => {
            bound = value;
            return read;
          },
          order: () => read,
          limit: () => read,
          maybeSingle: async () => {
            if (said) {
              const left = said.filter((m) => bound === undefined || m.created_at <= bound);
              const latest = left.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
              return { data: latest ? { content: latest.content } : null, error: null };
            }
            return theirLast instanceof Error
              ? { data: null, error: { message: theirLast.message } }
              : { data: theirLast === null ? null : { content: theirLast }, error: null };
          },
        };
        return {
          select: () => read,
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
  // Confirmed (0096): an address that has not said yes is not mailed, and
  // that is `address-confirmation.test.ts`'s to hold.
  channelRow = {
    id: "ch-1",
    user_id: "user-1",
    kind: "email",
    secret_ciphertext: "v1.x",
    confirmed_at: "2026-10-01T00:00:00Z",
    confirmation_sent_at: null,
  };
  sessionExists = true;
  inserted = [];
  messageInsertFails = false;
  theirLast = null;
  said = null;
  bound = undefined;
  tasks = {};
  waitingInLine = false;
  marked = [];
  complete.mockReset();
  complete.mockResolvedValue({
    text: "Example.com lists three tiers: Starter at $29/mo, Pro at $99/mo, and Enterprise on request.",
    usage: { promptTokens: 300, completionTokens: 40 } as CompletionUsage,
    finishReason: "stop",
  });
  deliverFn.mockReset();
  completeHeldRun.mockReset();
  record.mockReset();
  hasSavedCredential.mockReset();
  hasSavedCredential.mockResolvedValue(false);
  credentialCoversHost.mockReset();
  credentialCoversHost.mockResolvedValue(false);
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
   * Charged, against the message rather than the task. It used to be left
   * off because the task's provisional hold stood for far more — but the hold
   * is settled to the provider's own figure, which knows nothing of this
   * completion, so after settling nobody had paid for it. Filed without the
   * task's id: a ledger row carrying it would be folded into what the settle
   * makes equal the provider's bill, and refunded.
   */
  it("charges the workspace for the phrasing call, filed against the message", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0]).toMatchObject({ prompt_tokens: 300, completion_tokens: 40 });
    expect(record).toHaveBeenCalledTimes(1);
    const [workspaceId, spent, ref] = record.mock.calls[0] as [
      string,
      Array<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    expect(workspaceId).toBe(ROW.workspace_id);
    expect(spent[0]).toMatchObject({
      kind: "completion",
      promptTokens: 300,
      completionTokens: 40,
      purpose: "summary",
    });
    expect(ref).not.toHaveProperty("browserTaskId");
    expect(ref).toMatchObject({ userId: ROW.user_id, sessionId: ROW.session_id });
  });

  it("notifies the person through their delivery channel", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(deliverFn).toHaveBeenCalledTimes(1);
  });

  // The conversation carries on with the step by itself (0117, and from the
  // cron since 0142), so the answer is not news yet; the turn that ends the
  // chain sends the nudge instead.
  it("does not nudge for a task that carries a step after it", async () => {
    await deliverBrowserTask({ ...ROW, then_step: "post it to Slack" }, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
    expect(deliverFn).not.toHaveBeenCalled();
  });

  // A step behind a task still in the line — one held by a sign-in nobody
  // has done, say — cannot be claimed until that task is answered, which may
  // be never. Then the answer is news after all.
  it("nudges for a task with a step after it while another task is still in the line", async () => {
    waitingInLine = true;
    await deliverBrowserTask({ ...ROW, then_step: "post it to Slack" }, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
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

  it("marks the task delivered once its answer is in the conversation (0117)", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(marked).toHaveLength(1);
    expect(marked[0].id).toBe(ROW.id);
    expect(typeof marked[0].delivered_at).toBe("string");
  });

  it("does not mark a task delivered whose answer could not be written", async () => {
    messageInsertFails = true;
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(marked).toEqual([]);
  });
});

describe("a v4 run that stopped short (ruling R8's outcome)", () => {
  const LOGIN: FinishedTask = {
    status: "failed",
    output: null,
    error: null,
    costUsd: 0.04,
    reported: { status: "login_required", host: "linkedin.com", answer: null },
  };

  /**
   * The one failure a person can fix with their own hands while the browser
   * is still there. So the message names the site and points at the panel,
   * in one sentence, through the same model call as every other answer —
   * which is what puts it in the person's language.
   */
  it("asks for a sign-in on the named site, and says the browser panel is waiting", async () => {
    complete.mockResolvedValue({
      text: "LinkedIn wants you to sign in — the browser beside this chat is waiting for you.",
      usage: { promptTokens: 120, completionTokens: 20 } as CompletionUsage,
      finishReason: "stop",
    });
    await deliverBrowserTask(ROW, LOGIN, ENV, fakeDb());

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][1];
    const prompt = request.messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("linkedin.com");
    expect(prompt).toMatch(/sign in/i);
    expect(prompt).toMatch(/browser panel/i);
    expect(prompt).toMatch(/one sentence/i);
    expect(prompt).toMatch(/language/i);
    expect(String(inserted[0].content)).toContain("LinkedIn wants you to sign in");
  });

  it("still names the site and the panel when the model call fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    complete.mockRejectedValue(new Error("provider down"));
    await deliverBrowserTask(ROW, LOGIN, ENV, fakeDb());
    error.mockRestore();
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0].content)).toContain("linkedin.com");
    expect(String(inserted[0].content)).toMatch(/browser/i);
  });

  /**
   * The run's `host` is a model's words, and settle already narrows it to a
   * bare host before it stores one. The message says the same site the panel
   * does, not the raw string — a URL with a path and capitals is not a site's
   * name, and a sentence carrying one reads like a link.
   */
  it("names the site as a bare host, the way the panel does", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    complete.mockRejectedValue(new Error("provider down"));
    await deliverBrowserTask(
      ROW,
      {
        ...LOGIN,
        reported: {
          status: "login_required",
          host: "https://LinkedIn.com:443/login",
          answer: null,
        },
      },
      ENV,
      fakeDb(),
    );
    error.mockRestore();
    expect(String(inserted[0].content)).toMatch(/^linkedin\.com needs you to sign in/);
  });

  it("falls back to a description when the host is not a host at all", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    complete.mockRejectedValue(new Error("provider down"));
    await deliverBrowserTask(
      ROW,
      { ...LOGIN, reported: { status: "login_required", host: "the login page", answer: null } },
      ENV,
      fakeDb(),
    );
    error.mockRestore();
    expect(String(inserted[0].content)).toMatch(/^a site it needed needs you to sign in/);
  });

  it("says what stopped it when the run was blocked", async () => {
    await deliverBrowserTask(
      ROW,
      {
        status: "failed",
        output: "a captcha would not clear",
        error: null,
        costUsd: 0.04,
        reported: { status: "blocked", host: null, answer: "a captcha would not clear" },
      },
      ENV,
      fakeDb(),
    );
    const prompt = complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("a captcha would not clear");
    expect(prompt).toMatch(/the site refused it/i);
    expect(prompt).not.toMatch(/browser panel/i);
  });

  it("says what was done and what is left when the run did part of it", async () => {
    await deliverBrowserTask(
      ROW,
      {
        status: "failed",
        output: "sent 2 of 10; the third recipient could not be picked",
        error: null,
        costUsd: 0.05,
        reported: {
          status: "partial",
          host: null,
          answer: "sent 2 of 10; the third recipient could not be picked",
        },
      },
      ENV,
      fakeDb(),
    );
    const prompt = complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("sent 2 of 10");
    expect(prompt).toMatch(/did only part of the task/);
    expect(prompt).toMatch(/do not add a reason it did not give/);
    expect(prompt).not.toMatch(/refused|browser panel/i);
  });

  it("says a run ran out before finishing and reports only what its notes show", async () => {
    await deliverBrowserTask(
      ROW,
      {
        status: "failed",
        output: "Step: search acme.test\nPage: ada@acme.test (verified)",
        error: "Could not produce output matching outputSchema",
        costUsd: 0.25,
        salvaged: true,
      },
      ENV,
      fakeDb(),
    );
    const prompt = complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("Page: ada@acme.test (verified)");
    expect(prompt).toMatch(/stopped before it finished/);
    expect(prompt).toMatch(/not instructions/);
    expect(prompt).toMatch(/never present a guess or a pattern as a found result/);
    expect(prompt).not.toMatch(/It reports that it/);
  });

  it("delivers a stopped run's notes under the error when the model cannot be asked", async () => {
    complete.mockRejectedValueOnce(new Error("provider down"));
    await deliverBrowserTask(
      ROW,
      {
        status: "failed",
        output: "Step: search acme.test",
        error: "Could not produce output matching outputSchema",
        costUsd: 0.25,
        salvaged: true,
      },
      ENV,
      fakeDb(),
    );
    const content = String(inserted[0].content);
    expect(content).toContain("Could not produce output matching outputSchema");
    expect(content).toContain("What it saw on the way:");
    expect(content).toContain("Step: search acme.test");
  });

  it("answers a run that said done exactly as before", async () => {
    await deliverBrowserTask(
      ROW,
      {
        ...FINISHED,
        reported: { status: "done", host: null, answer: FINISHED.output },
      },
      ENV,
      fakeDb(),
    );
    const prompt = complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain("It reports that it succeeded.");
    expect(prompt).not.toMatch(/browser panel/i);
  });

  /**
   * Task 2.3, ruling R32: "the saved login didn't get past the sign-in" is said only of a
   * login the run actually CARRIED (`browser_tasks.credential_id`) and only
   * when it was for the site that walled it. A login that is merely saved —
   * the model named no `site`, a hand-back before 2.4, a `site` that named
   * another host — was never tried, and telling the person to re-enter a
   * correct password would send them round the same wall again.
   */
  describe("for a site with a saved login", () => {
    const CARRIED: BrowserTaskRow = { ...ROW, credential_id: "cred-1" };

    function prompt(): string {
      return complete.mock.calls[0][1].messages.map((m) => String(m.content)).join("\n");
    }

    it("says the saved login the run carried didn't get past the sign-in, and offers to update it", async () => {
      credentialCoversHost.mockResolvedValue(true);
      const db = fakeDb();

      await deliverBrowserTask(CARRIED, LOGIN, ENV, db);

      // Asked of the login the row names and the host as the panel names it,
      // through the service-role client deliver already holds.
      expect(credentialCoversHost).toHaveBeenCalledTimes(1);
      expect(credentialCoversHost.mock.calls[0][1]).toEqual({
        credentialId: "cred-1",
        host: "linkedin.com",
      });
      expect(credentialCoversHost.mock.calls[0][2]).toEqual({ db });

      expect(complete).toHaveBeenCalledTimes(1);
      expect(prompt()).toContain("linkedin.com");
      expect(prompt()).toMatch(/saved login/i);
      expect(prompt()).toMatch(/didn't get past the sign-in/i);
      expect(prompt()).toMatch(/offer to update it/i);
      expect(prompt()).toMatch(/one sentence/i);
      expect(prompt()).toMatch(/language/i);
      // Not the no-login wording: it HAD a sign-in for it.
      expect(prompt()).not.toMatch(/has no sign-in for it/i);
      expect(inserted).toHaveLength(1);
    });

    it("still says so when the model call fails", async () => {
      credentialCoversHost.mockResolvedValue(true);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      complete.mockRejectedValue(new Error("provider down"));

      await deliverBrowserTask(CARRIED, LOGIN, ENV, fakeDb());

      error.mockRestore();
      const content = String(inserted[0].content);
      expect(content).toContain("linkedin.com");
      expect(content).toMatch(/saved login/i);
      expect(content).toMatch(/didn't get past the sign-in/i);
      expect(content).toMatch(/update/i);
    });

    /**
     * The run carried a login for one site and hit the wall on another — a
     * sign-in that hands over to a single sign-on provider, say. The carried
     * login was never asked for there, so it is not what failed.
     */
    it("does not blame a carried login for a wall on a host it was not for", async () => {
      credentialCoversHost.mockResolvedValue(false);

      await deliverBrowserTask(CARRIED, LOGIN, ENV, fakeDb());

      expect(prompt()).toMatch(/has no sign-in for it/i);
      expect(prompt()).not.toMatch(/did not work|didn't get past the sign-in/i);
    });

    /**
     * Case (a) of the finding: a login is saved, but this run never had it.
     * Today's sign-in wording, plus the one clause that is true — asking again
     * will use it — and never "did not work".
     */
    it("asks for a sign-in, and says a saved login exists, when the run carried none", async () => {
      hasSavedCredential.mockResolvedValue(true);

      await deliverBrowserTask(ROW, LOGIN, ENV, fakeDb());

      expect(credentialCoversHost).not.toHaveBeenCalled();
      expect(hasSavedCredential).toHaveBeenCalledTimes(1);
      expect(hasSavedCredential.mock.calls[0][1]).toEqual({
        agentId: "agent-1",
        userId: "user-1",
        host: "linkedin.com",
      });
      expect(prompt()).toMatch(/has no sign-in for it/i);
      expect(prompt()).toMatch(/browser panel/i);
      expect(prompt()).toMatch(/a login is saved for linkedin\.com/i);
      // The panel's button, never "ask again", which looped (2026-10-11).
      expect(prompt()).toMatch(/panel can try again with the saved login/i);
      expect(prompt()).not.toMatch(/ask again/i);
      expect(prompt()).not.toMatch(/did not work|didn't get past the sign-in/i);
      expect(prompt()).not.toMatch(/update it/i);
    });

    it("says the same in the plain fallback when the model call fails", async () => {
      hasSavedCredential.mockResolvedValue(true);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      complete.mockRejectedValue(new Error("provider down"));

      await deliverBrowserTask(ROW, LOGIN, ENV, fakeDb());

      error.mockRestore();
      const content = String(inserted[0].content);
      expect(content).toMatch(/^linkedin\.com needs you to sign in/);
      expect(content).toMatch(/saved login/i);
      expect(content).toMatch(/try again there with your saved login/i);
      expect(content).not.toMatch(/ask again/i);
      expect(content).not.toMatch(/did not work|didn't get past the sign-in/i);
    });

    it("asks for a sign-in exactly as before when no login is saved for the site", async () => {
      await deliverBrowserTask(ROW, LOGIN, ENV, fakeDb());

      expect(hasSavedCredential).toHaveBeenCalledTimes(1);
      expect(prompt()).toMatch(/has no sign-in for it/i);
      expect(prompt()).not.toMatch(/saved login|login is saved/i);
    });

    /**
     * Both lookups throw on a read error (2.2). That must cost the person the
     * better sentence and nothing more: the delivery still happens, in
     * today's words.
     */
    it.each([
      [
        "whether the carried login was for this site",
        CARRIED,
        () =>
          credentialCoversHost.mockRejectedValue(
            new Error("browser_credentials: read failed (57014)"),
          ),
      ],
      [
        "whether a login is saved",
        ROW,
        () =>
          hasSavedCredential.mockRejectedValue(
            new Error("browser_credentials: read failed (57014)"),
          ),
      ],
    ])("falls back to today's sign-in wording when it cannot read %s", async (_l, row, arrange) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      arrange();

      await deliverBrowserTask(row, LOGIN, ENV, fakeDb());

      warn.mockRestore();
      error.mockRestore();
      expect(inserted).toHaveLength(1);
      expect(prompt()).toMatch(/has no sign-in for it/i);
      expect(prompt()).not.toMatch(/saved login|login is saved/i);
    });

    it("asks nothing when the run named no usable host, or did not stop at a login wall", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      complete.mockRejectedValue(new Error("provider down"));
      await deliverBrowserTask(
        CARRIED,
        { ...LOGIN, reported: { status: "login_required", host: "the login page", answer: null } },
        ENV,
        fakeDb(),
      );
      await deliverBrowserTask(CARRIED, FINISHED, ENV, fakeDb());
      error.mockRestore();
      expect(hasSavedCredential).not.toHaveBeenCalled();
      expect(credentialCoversHost).not.toHaveBeenCalled();
    });
  });
});

/**
 * Measured 2026-10-11: an English conversation got its login-wall sentence in
 * Spanish. The prompt said "in the language they asked in" and showed only
 * `row.task`, which the chat model writes in English whatever the person did.
 * Quoting their words inside the brief made it worse; their words as the user
 * turn, with the brief as the system message, held on gpt-4.1-mini.
 *
 * 2026-10-11 21:32, on Claude: with their words as the user turn, the answer
 * did what their message asked — three sites, compared — and made up two of
 * them. Now their words go only to a call that names the language, and the
 * answer is told it by name (see `SYSTEM`).
 */
describe("the language of the answer", () => {
  const WALL: FinishedTask = {
    status: "failed",
    output: null,
    error: null,
    costUsd: 0.01,
    reported: { status: "login_required", host: "the-internet.herokuapp.com", answer: null },
  };
  const TURKISH = "Şu sayfadaki fiyat tablosunu okuyup bana özetler misin?";
  const asking = () => complete.mock.calls[0][1].messages;
  const answering = () => complete.mock.calls.at(-1)![1].messages;
  const names = (language: string) =>
    complete.mockResolvedValueOnce({
      text: language,
      usage: { promptTokens: 50, completionTokens: 2 } as CompletionUsage,
      finishReason: "stop",
    });

  it("asks which language in a call of its own, with their words as its user turn", async () => {
    theirLast = TURKISH;
    await deliverBrowserTask(ROW, WALL, ENV, fakeDb());
    expect(complete).toHaveBeenCalledTimes(2);
    expect(asking()).toHaveLength(2);
    expect(String(asking()[0].content)).toMatch(/Name the language/);
    expect(asking()[1]).toEqual({ role: "user", content: TURKISH });
  });

  it("tells the answer the language by name, and never shows it their words", async () => {
    theirLast = TURKISH;
    names("Turkish");
    await deliverBrowserTask(ROW, WALL, ENV, fakeDb());
    expect(answering()).toHaveLength(2);
    expect(String(answering()[0].content)).toContain("Write in Turkish.");
    expect(answering()[1]).toMatchObject({ role: "user" });
    expect(String(answering()[1].content)).toContain(ROW.task);
    expect(String(answering()[1].content)).toContain("the-internet.herokuapp.com");
    expect(JSON.stringify(answering())).not.toContain(TURKISH);
  });

  it("keeps their request out of the answer even when it asks for more than this task", async () => {
    theirLast = "Review the repo, the site and Tasklet, then write it all up.";
    names("English");
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(JSON.stringify(answering())).not.toContain("Tasklet");
    expect(String(answering()[0].content)).toContain("never say you looked at anything else");
    expect(String(answering()[0].content)).toContain("Write no tool calls or code");
  });

  it("names no language when the answer was not a plain name", async () => {
    theirLast = TURKISH;
    names("The message is written in Turkish, a Turkic language.");
    await deliverBrowserTask(ROW, WALL, ENV, fakeDb());
    expect(String(answering()[0].content)).toContain(
      "Write in the language the person uses with you",
    );
  });

  it("still delivers when the language cannot be asked", async () => {
    theirLast = TURKISH;
    complete.mockRejectedValueOnce(new Error("provider down"));
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
    expect(String(answering()[0].content)).toContain(
      "Write in the language the person uses with you",
    );
  });

  it("counts the language call in the row's tokens", async () => {
    theirLast = TURKISH;
    names("Turkish");
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0]).toMatchObject({ prompt_tokens: 350, completion_tokens: 42 });
  });

  it("shows the language call only so much of them: enough to tell a language", async () => {
    theirLast = "a".repeat(5_000);
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(asking()[1]).toEqual({ role: "user", content: "a".repeat(400) });
  });

  it("still delivers, with no language call, when their words cannot be read", async () => {
    theirLast = new Error("timeout");
    await deliverBrowserTask(ROW, WALL, ENV, fakeDb());
    expect(inserted).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(answering()[1].content)).toContain(ROW.task);
  });
});

/**
 * 2026-10-11 21:32: the answer to a task about a GitHub repo described
 * tasklet.ai — a site no browser had opened. And on 2026-10-11, made-up tool
 * calls in YAML stood in for two answers. Either way the report itself goes out.
 */
describe("an answer that goes past the report", () => {
  const replies = (text: string) =>
    complete.mockResolvedValue({
      text,
      usage: { promptTokens: 300, completionTokens: 40 } as CompletionUsage,
      finishReason: "stop",
    });

  it("is replaced by the report when it names a site the report does not", async () => {
    replies("Example.com has three tiers. Tasklet.ai, by comparison, raised $40M.");
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0].content).toBe(FINISHED.output);
  });

  it("is kept when every site it names is in the task or the report", async () => {
    replies(
      "On www.example.com: Starter $29/mo, Pro $99/mo, Enterprise on request (see README.md).",
    );
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0].content).toContain("Starter $29/mo");
  });

  it("is replaced by the report when it carries tool-call markup", async () => {
    replies('Let me look.\n<function_calls><invoke name="browse"></invoke></function_calls>');
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0].content).toBe(FINISHED.output);
  });

  it("is replaced by the report when it writes a tool call in YAML", async () => {
    replies("```yaml\ntool: browse\ntask: covan.app\n```");
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(inserted[0].content).toBe(FINISHED.output);
  });

  it("leaves a login wall's sentence alone: the site it names is the one the run reported", async () => {
    replies("the-internet.herokuapp.com wants you to sign in; the browser panel is waiting.");
    await deliverBrowserTask(
      ROW,
      {
        status: "failed",
        output: null,
        error: null,
        costUsd: 0.01,
        reported: { status: "login_required", host: "the-internet.herokuapp.com", answer: null },
      },
      ENV,
      fakeDb(),
    );
    expect(inserted[0].content).toContain("browser panel is waiting");
  });
});

/**
 * 2026-10-11: two covan.app results were phrased against "start them again"
 * and "scan them in order", sent while the browser worked, and answered those
 * instead of delivering what it found.
 */
describe("which of their messages is shown", () => {
  // To the language call, the only one that sees their words.
  const sent = () => complete.mock.calls[0][1].messages;
  const ASKED = "Covan'ın sitesini tarayıcıyla incele.";
  const LATER = "Görevleri yeniden başlat ve sırayla tara.";

  beforeEach(() => {
    said = [
      { content: "Merhaba", created_at: "2026-10-11T15:19:00.000Z" },
      { content: ASKED, created_at: "2026-10-11T15:20:00.000Z" },
      { content: LATER, created_at: "2026-10-11T15:25:00.000Z" },
    ];
  });

  it("shows the one that started the task, not one sent while it ran", async () => {
    await deliverBrowserTask(
      { ...ROW, created_at: "2026-10-11T15:20:05.000Z" },
      FINISHED,
      ENV,
      fakeDb(),
    );
    expect(bound).toBe("2026-10-11T15:20:05.000Z");
    expect(sent()[1]).toEqual({ role: "user", content: ASKED });
  });

  it("shows the message that started the original for a retry, made later by a button", async () => {
    tasks = { "bt-0": { created_at: "2026-10-11T15:20:05.000Z" } };
    await deliverBrowserTask(
      { ...ROW, created_at: "2026-10-11T15:30:00.000Z", retry_of: "bt-0" },
      FINISHED,
      ENV,
      fakeDb(),
    );
    expect(sent()[1]).toEqual({ role: "user", content: ASKED });
  });

  it("bounds a retry by its own time when its original cannot be read", async () => {
    tasks = new Error("timeout");
    await deliverBrowserTask(
      { ...ROW, created_at: "2026-10-11T15:22:00.000Z", retry_of: "bt-0" },
      FINISHED,
      ENV,
      fakeDb(),
    );
    expect(bound).toBe("2026-10-11T15:22:00.000Z");
    expect(sent()[1]).toEqual({ role: "user", content: ASKED });
    expect(inserted).toHaveLength(1);
  });

  it("reads the latest, as before, for a row that carries no time", async () => {
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());
    expect(bound).toBeUndefined();
    expect(sent()[1]).toEqual({ role: "user", content: LATER });
  });
});

/**
 * A routine's task (0100). Its answer is written into the routine's report,
 * which is phrased and sent once by `lib/routines/held.ts` — so here it is the
 * browser's own words in the conversation, no model call, and no notice.
 */
describe("a routine's task", () => {
  const ROUTINE_ROW: BrowserTaskRow = { ...ROW, routine_run_id: "run-1" };

  it("writes the browser's own report into the conversation, without phrasing it", async () => {
    await deliverBrowserTask(ROUTINE_ROW, FINISHED, ENV, fakeDb());

    expect(complete).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe(FINISHED.output);
  });

  it("notifies nobody, and asks the held report to finish", async () => {
    await deliverBrowserTask(ROUTINE_ROW, FINISHED, ENV, fakeDb());

    expect(deliverFn).not.toHaveBeenCalled();
    expect(completeHeldRun).toHaveBeenCalledOnce();
    expect(completeHeldRun.mock.calls[0][1]).toBe("run-1");
  });

  it("still asks the held report to finish when the conversation is gone", async () => {
    sessionExists = false;
    await deliverBrowserTask(ROUTINE_ROW, FINISHED, ENV, fakeDb());

    expect(inserted).toHaveLength(0);
    expect(completeHeldRun).toHaveBeenCalledOnce();
  });

  it("reads which run a task answers when its reader did not select the column", async () => {
    tasks = { "bt-1": { routine_run_id: "run-7" } as never };
    await deliverBrowserTask(ROW, FINISHED, ENV, fakeDb());

    expect(completeHeldRun.mock.calls[0][1]).toBe("run-7");
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("leaves a conversation's own task as it was", async () => {
    await deliverBrowserTask({ ...ROW, routine_run_id: null }, FINISHED, ENV, fakeDb());

    expect(completeHeldRun).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(deliverFn).toHaveBeenCalledOnce();
  });
});
