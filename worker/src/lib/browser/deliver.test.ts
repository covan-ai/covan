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
    expect(prompt).toMatch(/what stopped it/i);
    expect(prompt).not.toMatch(/browser panel/i);
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
      expect(prompt()).toMatch(/ask again/i);
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
      expect(content).toMatch(/ask again/i);
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
