import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { memoryDb, type Row } from "../../test-support/memory-db";
import type { BrowserTaskRow, FinishedTask } from "./poller";
import { finishedRun, readOutcome, settleBrowserTask } from "./settle";
import * as v4 from "./v4";
import type { RunSummary } from "./v4";

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-10T12:00:00.000Z");

function taskRow(over: Row = {}): Row {
  return {
    id: "bt-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "chat-1",
    provider_task_id: "run-secret-1",
    provider_run_id: "run-secret-1",
    browser_session_id: "bs-1",
    api_version: "v4",
    task: "read the pricing table",
    status: "running",
    poll_count: 0,
    ...over,
  };
}

function sessionRow(over: Row = {}): Row {
  return { id: "bs-1", live_state: "agent", provider_browser_id: "bu-browser-1", ...over };
}

const DONE: FinishedTask = {
  status: "finished",
  output: "Starter $29, Pro $99",
  error: null,
  costUsd: 0.12,
};

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-secret-1",
    status: "completed",
    result: null,
    output: null,
    error: null,
    totalCostUsd: 0.12,
    sessionId: "bu-session-1",
    ...over,
  };
}

const deliver = vi.fn(
  async (
    _row: BrowserTaskRow,
    _outcome: FinishedTask,
    _env: RoutineEnv,
    _db: SupabaseClient,
  ): Promise<void> => {},
);

let spoken: unknown[];

beforeEach(() => {
  deliver.mockReset();
  spoken = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void spoken.push(a));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void spoken.push(a));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(tasks: Row[] = [taskRow()], sessions: Row[] = [sessionRow()]) {
  const mem = memoryDb({ browser_tasks: tasks, browser_sessions: sessions });
  const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW, deliver };
  return { mem, deps };
}

describe("readOutcome (ruling R8)", () => {
  it("reads the provider's structured output when it is an object with a known status", () => {
    expect(
      readOutcome({
        output: { status: "login_required", host: "linkedin.com" },
        result: "ignored prose",
      }),
    ).toEqual({ status: "login_required", host: "linkedin.com", answer: null });
  });

  it("falls back to the JSON the preamble asked for, in the prose result", () => {
    expect(
      readOutcome({
        output: null,
        result: '  {"status":"done","answer":"Starter $29, Pro $99"}\n',
      }),
    ).toEqual({ status: "done", host: null, answer: "Starter $29, Pro $99" });
  });

  it("reads that JSON out of a fenced block too", () => {
    expect(
      readOutcome({
        output: null,
        result: '```json\n{"status":"blocked","answer":"a captcha would not clear"}\n```',
      }),
    ).toEqual({ status: "blocked", host: null, answer: "a captcha would not clear" });
  });

  it("treats prose that is not that JSON as a plain answer", () => {
    expect(readOutcome({ output: null, result: "Starter $29, Pro $99" })).toEqual({
      status: "done",
      host: null,
      answer: "Starter $29, Pro $99",
    });
  });

  it("does not trust a status word the schema does not have, from either channel", () => {
    expect(
      readOutcome({ output: { status: "maybe", answer: "x" }, result: '{"status":"weird"}' }),
    ).toEqual({ status: "done", host: null, answer: '{"status":"weird"}' });
    expect(readOutcome({ output: ["login_required"], result: null })).toBeNull();
    expect(readOutcome({ output: "login_required", result: "" })).toBeNull();
    expect(readOutcome({ output: null, result: null })).toBeNull();
  });

  it("ignores a host or answer that is not text", () => {
    expect(
      readOutcome({ output: { status: "login_required", host: 42, answer: {} }, result: null }),
    ).toEqual({ status: "login_required", host: null, answer: null });
  });
});

describe("finishedRun", () => {
  it("is a finished task when the run completed and said done", () => {
    expect(finishedRun(summary({ result: "Starter $29, Pro $99" }))).toMatchObject({
      status: "finished",
      output: "Starter $29, Pro $99",
      error: null,
      costUsd: 0.12,
    });
  });

  /**
   * v2's `isSuccess: false` reasoning: the run ended and did not do the thing,
   * so the row is honest about it — and what it reported travels with it, so
   * the conversation can name the site.
   */
  it("is a failure that still says why when the run stopped at a login wall", () => {
    const ended = finishedRun(
      summary({ output: { status: "login_required", host: "linkedin.com" } }),
    );
    expect(ended).toMatchObject({ status: "failed", output: null });
    expect(ended.reported).toEqual({
      status: "login_required",
      host: "linkedin.com",
      answer: null,
    });
  });

  /**
   * The provider honoured the schema with `{status: "done"}` and left `answer`
   * out — it is optional in the schema — while the prose it wrote is in
   * `result`. Delivering "finished" with no output would put an empty answer in
   * the conversation over a run that said what it found.
   */
  it("delivers the prose result when a structured done carries no answer", () => {
    expect(
      finishedRun(summary({ output: { status: "done" }, result: "Starter $29, Pro $99" })),
    ).toMatchObject({ status: "finished", output: "Starter $29, Pro $99" });
  });

  it("does not deliver the outcome JSON itself as the answer", () => {
    expect(
      finishedRun(summary({ output: { status: "done" }, result: '{"status":"done"}' })),
    ).toMatchObject({ status: "finished", output: null });
  });

  it("keeps the structured answer when there is one", () => {
    expect(
      finishedRun(
        summary({ output: { status: "done", answer: "Pro $99" }, result: "a longer story" }),
      ),
    ).toMatchObject({ output: "Pro $99" });
  });

  it("records a cancelled run as stopped, and why", () => {
    expect(finishedRun(summary({ status: "cancelled" }))).toMatchObject({
      status: "stopped",
      stopReason: "cancelled",
    });
  });

  it("says a failed run produced nothing when it did not", () => {
    const ended = finishedRun(summary({ status: "failed", totalCostUsd: null }));
    expect(ended).toMatchObject({ status: "failed", output: null, costUsd: null });
    expect(ended.error).toMatch(/failed without producing an answer/);
  });
});

describe("settleBrowserTask", () => {
  it("claims the row with a conditional flip to terminal, then delivers once", async () => {
    const { mem, deps } = setup();

    const delivered = await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

    expect(delivered).toBe(true);
    const claim = mem.callsTo("browser_tasks")[0];
    expect(claim.op).toBe("update");
    expect(claim.filters).toEqual([
      { column: "id", value: "bt-1", kind: "eq" },
      { column: "status", value: ["queued", "running"], kind: "in" },
    ]);
    expect(claim.values).toMatchObject({
      status: "finished",
      claimed_at: null,
      output: "Starter $29, Pro $99",
      cost_usd: 0.12,
      finished_at: NOW.toISOString(),
    });
    expect(mem.tables.browser_tasks[0].status).toBe("finished");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toBe(DONE);
  });

  /**
   * Ruling R32. Whether the run carried a saved login is the row's to say,
   * and the two clocks hand settle rows read with different column lists — so
   * the claim reads it back itself and deliver is given the row's own answer,
   * not whatever the caller happened to select.
   */
  const WALL: FinishedTask = {
    status: "failed",
    output: null,
    error: null,
    costUsd: 0.05,
    reported: { status: "login_required", host: "linkedin.com", answer: null },
  };

  it("hands deliver the saved login a walled run carried, read back from the row", async () => {
    const { deps } = setup([taskRow({ credential_id: "cred-1" })]);

    // The caller's copy says nothing about it, as the open tab's read does not.
    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, WALL, deps);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ id: "bt-1", credential_id: "cred-1" });
  });

  it("hands deliver no saved login when the run carried none", async () => {
    const { deps } = setup([taskRow({ credential_id: null })]);

    await settleBrowserTask(
      ENV,
      taskRow({ credential_id: "stale-caller-copy" }) as BrowserTaskRow,
      WALL,
      deps,
    );

    expect(deliver.mock.calls[0][0].credential_id).toBeNull();
  });

  /**
   * Final review #6: the claim is the write every settle depends on, and it
   * must not depend on 0079 — a worker deployed before the migration would
   * otherwise fail every claim on an unknown column. `credential_id` matters
   * only to a login wall's sentence, so only a wall reads it, after the claim.
   */
  it("claims without naming credential_id, and reads it only for a login wall", async () => {
    const { mem, deps } = setup([taskRow({ credential_id: "cred-1" })]);

    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

    const claim = mem.callsTo("browser_tasks")[0];
    expect(claim.op).toBe("update");
    expect(String(claim.columns)).not.toContain("credential_id");
    expect(
      mem.callsTo("browser_tasks").some((c) => String(c.columns).includes("credential_id")),
    ).toBe(false);
    expect(deliver.mock.calls[0][0].credential_id).toBeNull();
  });

  it("still delivers a login wall, as one that carried no login, when that read fails", async () => {
    const mem = memoryDb(
      { browser_tasks: [taskRow({ credential_id: "cred-1" })], browser_sessions: [sessionRow()] },
      (ctx) =>
        ctx.table === "browser_tasks" && ctx.op === "select"
          ? { data: null, error: { code: "42703", message: "column does not exist" } }
          : undefined,
    );
    const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW, deliver };

    const delivered = await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, WALL, deps);

    expect(delivered).toBe(true);
    expect(deliver.mock.calls[0][0].credential_id).toBeNull();
    expect(JSON.stringify(spoken)).not.toContain("cred-1");
  });

  it("the claim is the first thing it does: nothing is read or written before it", async () => {
    const { mem, deps } = setup();
    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);
    expect(mem.calls[0]).toMatchObject({ table: "browser_tasks", op: "update" });
  });

  it("delivers nothing when somebody else already settled the row", async () => {
    const { mem, deps } = setup([taskRow({ status: "finished" })]);

    const delivered = await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

    expect(delivered).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    // And leaves the browser's state alone: it is the winner's to write.
    expect(mem.callsTo("browser_sessions")).toEqual([]);
  });

  /**
   * Task 1.5's take-over marks the task `stopped` with this same conditional
   * update (ruling R5). A run that ends while the person is taking over must
   * not then answer into the conversation as if nobody had.
   */
  it("delivers nothing after a take-over stopped the task", async () => {
    const { deps } = setup([taskRow({ status: "stopped", stop_reason: "handed_to_person" })]);
    expect(await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers exactly once when two clocks settle the same run at the same moment", async () => {
    const { mem, deps } = setup();

    const results = await Promise.all([
      settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps),
      settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(mem.callsTo("browser_tasks").filter((c) => c.op === "update")).toHaveLength(2);
  });

  /**
   * 0080: the browser is free, so the next task in its line starts — after
   * the answer, so the person reads the first result before the second is
   * under way.
   */
  describe("the task waiting behind it", () => {
    it("is started in the claimed row's browser, after the answer is delivered", async () => {
      const { deps } = setup();
      const order: string[] = [];
      deliver.mockImplementation(async () => void order.push("deliver"));
      const advance = vi.fn(async (_id: string) => void order.push("advance"));

      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, { ...deps, advance });

      expect(advance).toHaveBeenCalledWith("bs-1");
      expect(order).toEqual(["deliver", "advance"]);
    });

    it("is not started by a settle that lost the claim", async () => {
      const { deps } = setup([taskRow({ status: "finished" })]);
      const advance = vi.fn(async () => {});
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, { ...deps, advance });
      expect(advance).not.toHaveBeenCalled();
    });

    it("cannot undo the settle when it fails to start", async () => {
      const { deps } = setup();
      const advance = vi.fn(async () => {
        throw new Error("provider down");
      });
      expect(
        await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, { ...deps, advance }),
      ).toBe(true);
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });

  it("hands the browser back from the agent (ruling R4)", async () => {
    const { mem, deps } = setup();
    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);
    expect(mem.tables.browser_sessions[0].live_state).toBe("none");
    const write = mem.callsTo("browser_sessions")[0];
    expect(write.values).toEqual({ live_state: "none" });
    expect(write.filters).toEqual([
      { column: "id", value: "bs-1", kind: "eq" },
      { column: "live_state", value: "agent", kind: "eq" },
    ]);
  });

  /**
   * Ruling R20's marker. The idle sweep stops a browser by the row's
   * `provider_browser_id`, and only an open tab's event drain used to write
   * it — so a run whose tab was closed left a browser the sweep could not
   * see. The run's end is when it is learned instead: in the release's own
   * write's answer, and only when the row names none.
   */
  describe("the browser a run leaves open", () => {
    let browsersFor: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      browsersFor = vi.spyOn(v4, "browsersFor").mockResolvedValue({
        kind: "ok",
        value: [
          { id: "bu-old", status: "stopped" },
          { id: "bu-browser-9", status: "active" },
        ],
      });
    });

    it("is recorded when no open tab named it", async () => {
      const { mem, deps } = setup(
        [taskRow()],
        [sessionRow({ provider_session_id: "bu-session-1", provider_browser_id: null })],
      );

      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

      expect(browsersFor).toHaveBeenCalledWith(ENV, "bu-session-1", expect.anything());
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        provider_browser_id: "bu-browser-9",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it("is reported to the caller that settled, and only when this settle named it", async () => {
      const onBrowserNamed = vi.fn();
      const unnamed = setup(
        [taskRow()],
        [sessionRow({ provider_session_id: "bu-session-1", provider_browser_id: null })],
      );
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, {
        ...unnamed.deps,
        onBrowserNamed,
      });
      expect(onBrowserNamed).toHaveBeenCalledExactlyOnceWith("bu-browser-9");

      onBrowserNamed.mockClear();
      const named = setup([taskRow()], [sessionRow({ provider_session_id: "bu-session-1" })]);
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, {
        ...named.deps,
        onBrowserNamed,
      });
      expect(onBrowserNamed).not.toHaveBeenCalled();
    });

    it("costs nothing when the row already names one", async () => {
      const { deps } = setup([taskRow()], [sessionRow({ provider_session_id: "bu-session-1" })]);

      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

      expect(browsersFor).not.toHaveBeenCalled();
    });

    it("is not looked for when the person, not the agent, holds the browser", async () => {
      const { deps } = setup(
        [taskRow()],
        [
          sessionRow({
            live_state: "human",
            provider_session_id: "bu-session-1",
            provider_browser_id: null,
          }),
        ],
      );

      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);

      expect(browsersFor).not.toHaveBeenCalled();
    });

    it("still delivers when the provider cannot list the browsers", async () => {
      browsersFor.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
      const { mem, deps } = setup(
        [taskRow()],
        [sessionRow({ provider_session_id: "bu-session-1", provider_browser_id: null })],
      );

      expect(await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps)).toBe(true);
      expect(mem.tables.browser_sessions[0].provider_browser_id).toBeNull();
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });

  it("never takes the browser out of the person's hands", async () => {
    const { mem, deps } = setup([taskRow()], [sessionRow({ live_state: "human" })]);
    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);
    expect(mem.tables.browser_sessions[0].live_state).toBe("human");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reads the browser from the row it claimed, not from what the caller passed", async () => {
    const { mem, deps } = setup();
    await settleBrowserTask(
      ENV,
      taskRow({ browser_session_id: "bs-somebody-else" }) as BrowserTaskRow,
      DONE,
      deps,
    );
    expect(mem.callsTo("browser_sessions")[0].filters[0]).toEqual({
      column: "id",
      value: "bs-1",
      kind: "eq",
    });
  });

  it("touches no browser for a v2 task, which has none", async () => {
    const { mem, deps } = setup([taskRow({ api_version: "v2", browser_session_id: null })]);
    await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);
    expect(mem.callsTo("browser_sessions")).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("writes why a run stopped when it knows", async () => {
    const { mem, deps } = setup();
    await settleBrowserTask(
      ENV,
      taskRow() as BrowserTaskRow,
      {
        status: "stopped",
        output: null,
        error: "cancelled",
        costUsd: null,
        stopReason: "cancelled",
      },
      deps,
    );
    expect(mem.tables.browser_tasks[0]).toMatchObject({
      status: "stopped",
      stop_reason: "cancelled",
    });
  });

  /**
   * The panel's in-panel prompt ("linkedin.com needs you to sign in") reads
   * `signin_host` off the row, because the outcome the run reported is not
   * otherwise kept anywhere. It goes in the claim, not a second write.
   */
  describe("signin_host", () => {
    const LOGIN = (host: string | null): FinishedTask => ({
      status: "failed",
      output: null,
      error: null,
      costUsd: 0.05,
      reported: { status: "login_required", host, answer: null },
    });

    it("is written, in the claim itself, when the run needed a sign-in and named a bare host", async () => {
      const { mem, deps } = setup();
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, LOGIN("linkedin.com"), deps);
      const writes = mem.callsTo("browser_tasks").filter((c) => c.op === "update");
      expect(writes).toHaveLength(1);
      expect(writes[0].values).toMatchObject({ status: "failed", signin_host: "linkedin.com" });
      expect(mem.tables.browser_tasks[0].signin_host).toBe("linkedin.com");
    });

    /**
     * A model's words, normalised rather than dropped: the panel with a host
     * says where to sign in, and "LinkedIn.com" or a pasted login URL names
     * the site as plainly as the bare host does.
     */
    it.each([
      ["a URL", "https://linkedin.com/login"],
      ["a URL with credentials and a port", "https://me:pw@www.linkedin.com:443/login"],
      ["a host with a port", "linkedin.com:443"],
      ["an uppercase host", "LinkedIn.com"],
      ["a host in whitespace", "  linkedin.com \n"],
    ])("is normalised to the bare host for %s", async (_label, host) => {
      const { mem, deps } = setup();
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, LOGIN(host), deps);
      const expected = host.includes("www.") ? "www.linkedin.com" : "linkedin.com";
      expect(mem.callsTo("browser_tasks")[0].values).toHaveProperty("signin_host", expected);
    });

    it.each([
      ["a host with credentials", "me@linkedin.com"],
      ["a host with a path", "linkedin.com/login"],
      ["a host with whitespace inside", "linked in.com"],
      ["an empty host", "   "],
      ["no host", null],
    ])("is null, never the raw string, for %s", async (_label, host) => {
      const { mem, deps } = setup();
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, LOGIN(host), deps);
      const claim = mem.callsTo("browser_tasks")[0];
      expect(claim.values).toHaveProperty("signin_host", null);
      expect(mem.tables.browser_tasks[0].signin_host).toBeNull();
    });

    it.each(["done", "blocked"] as const)(
      "is null when the outcome was %s, even with a host named",
      async (status) => {
        const { mem, deps } = setup();
        await settleBrowserTask(
          ENV,
          taskRow() as BrowserTaskRow,
          { ...DONE, reported: { status, host: "linkedin.com", answer: "x" } },
          deps,
        );
        expect(mem.callsTo("browser_tasks")[0].values).toHaveProperty("signin_host", null);
      },
    );

    it("is null when the run reported nothing at all", async () => {
      const { mem, deps } = setup();
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, deps);
      expect(mem.callsTo("browser_tasks")[0].values).toHaveProperty("signin_host", null);
    });
  });

  /**
   * Why a run ended without its answer, as the panel's positive signal.
   *
   * `failed` with no `error` is a login wall, a block AND a run that did not
   * complete but returned text, so the panel cannot key its "needs you to sign
   * in" on it. The reported outcome is the only place the difference lives,
   * and it is not kept — so it goes in `stop_reason`, in the claim.
   */
  describe("stop_reason from the reported outcome", () => {
    it("is login_required, in the claim itself, for a run that hit a login wall", async () => {
      const { mem, deps } = setup();
      const outcome = finishedRun(
        summary({ output: { status: "login_required", host: "linkedin.com" } }),
      );
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, outcome, deps);
      const writes = mem.callsTo("browser_tasks").filter((c) => c.op === "update");
      expect(writes).toHaveLength(1);
      expect(writes[0].values).toMatchObject({
        status: "failed",
        stop_reason: "login_required",
        signin_host: "linkedin.com",
      });
    });

    it("is login_required with no host when the run named none", async () => {
      const { mem, deps } = setup();
      const outcome = finishedRun(summary({ output: { status: "login_required" } }));
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, outcome, deps);
      expect(mem.tables.browser_tasks[0]).toMatchObject({
        status: "failed",
        stop_reason: "login_required",
        signin_host: null,
      });
    });

    it("is blocked for a run that was blocked", async () => {
      const { mem, deps } = setup();
      const outcome = finishedRun(summary({ output: { status: "blocked", host: "linkedin.com" } }));
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, outcome, deps);
      expect(mem.tables.browser_tasks[0]).toMatchObject({
        status: "failed",
        stop_reason: "blocked",
        signin_host: null,
      });
    });

    it("is not written for a run that did not complete but returned text", async () => {
      const { mem, deps } = setup();
      const outcome = finishedRun(summary({ status: "failed", result: "got halfway there" }));
      await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, outcome, deps);
      expect(mem.tables.browser_tasks[0].status).toBe("failed");
      expect(mem.tables.browser_tasks[0].error ?? null).toBeNull();
      expect(mem.tables.browser_tasks[0].stop_reason ?? null).toBeNull();
    });

    it("is not written for an answer", async () => {
      const { mem, deps } = setup();
      await settleBrowserTask(
        ENV,
        taskRow() as BrowserTaskRow,
        finishedRun(summary({ result: "ok" })),
        deps,
      );
      expect(mem.tables.browser_tasks[0].stop_reason ?? null).toBeNull();
    });
  });

  it("delivers nothing, and says so, when the claim cannot be written", async () => {
    const mem = memoryDb({ browser_tasks: [taskRow()], browser_sessions: [sessionRow()] }, (ctx) =>
      ctx.table === "browser_tasks"
        ? { data: null, error: { message: "connection reset", code: "XX000" } }
        : undefined,
    );
    const delivered = await settleBrowserTask(ENV, taskRow() as BrowserTaskRow, DONE, {
      db: mem.db as unknown as SupabaseClient,
      now: () => NOW,
      deliver,
    });
    expect(delivered).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(spoken.length).toBeGreaterThan(0);
  });
});
