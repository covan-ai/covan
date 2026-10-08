import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTask, taskStatus, stopTask, BROWSER_MAX_STEPS, type BrowserEnv } from "./client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as BrowserEnv;

beforeEach(() => {
  fetchMock.mockReset();
});

describe("createTask", () => {
  it("posts the task to v2 and returns the provider's ids", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "task-1", sessionId: "sess-1" }), { status: 202 }),
    );
    const result = await createTask(ENV, { task: "get the pricing table from example.com" });
    expect(result).toEqual({ kind: "ok", value: { id: "task-1", sessionId: "sess-1" } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browser-use.com/api/v2/tasks");
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    // No Bearer prefix. The provider's own header name.
    expect(init.headers["X-Browser-Use-API-Key"]).toBe("bu_test");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      task: "get the pricing table from example.com",
      maxSteps: BROWSER_MAX_STEPS,
    });
  });

  /**
   * The whole of "v1 is public web only", as a line of code rather than a
   * sentence in a doc. The provider accepts `secrets` and `opVaultId`; this
   * build never populates either, so there is nothing for a web page's
   * instructions to steal.
   */
  it("never sends credentials", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "t", sessionId: "s" }), { status: 202 }),
    );
    await createTask(ENV, { task: "log in to example.com and read my invoices" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.secrets).toBeUndefined();
    expect(body.opVaultId).toBeUndefined();
  });

  it("reports the concurrency pool being full as its own status", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Too many concurrent active sessions" }), {
        status: 429,
      }),
    );
    const result = await createTask(ENV, { task: "get the pricing table" });
    expect(result.kind).toBe("error");
    expect((result as { status: number }).status).toBe(429);
    expect((result as { message: string }).message).toContain(
      "Too many concurrent active sessions",
    );
  });

  it("honours BROWSER_USE_BASE_URL so a self-hoster can point it elsewhere", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "t", sessionId: "s" }), { status: 202 }),
    );
    await createTask(
      { ...ENV, BROWSER_USE_BASE_URL: "https://bu.internal/api/v2" },
      {
        task: "x".repeat(12),
      },
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://bu.internal/api/v2/tasks");
  });
});

describe("taskStatus", () => {
  it("reads the lightweight status endpoint and parses cost from a string", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task-1",
          status: "finished",
          output: "Starter $29, Pro $99",
          finishedAt: "2026-10-09T10:30:00",
          isSuccess: true,
          cost: "0.21",
        }),
        { status: 200 },
      ),
    );
    const result = await taskStatus(ENV, "task-1");
    expect(result).toEqual({
      kind: "ok",
      value: {
        status: "finished",
        output: "Starter $29, Pro $99",
        isSuccess: true,
        costUsd: 0.21,
        finishedAt: "2026-10-09T10:30:00",
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.browser-use.com/api/v2/tasks/task-1/status",
    );
  });

  /**
   * `cost` is a STRING at the provider and is absent on a task that has not
   * finished. `Number(undefined)` is NaN, and NaN into a numeric column fails
   * the insert — so the parse has to answer null, not NaN.
   */
  it("answers null rather than NaN when there is no cost yet", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "task-1", status: "started" }), { status: 200 }),
    );
    const result = await taskStatus(ENV, "task-1");
    expect(result).toEqual({
      kind: "ok",
      value: { status: "running", output: null, isSuccess: null, costUsd: null, finishedAt: null },
    });
  });

  it("answers null rather than NaN when the cost is not a number at all", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "t", status: "finished", cost: "n/a" }), { status: 200 }),
    );
    const result = await taskStatus(ENV, "t");
    expect((result as { value: { costUsd: number | null } }).value.costUsd).toBeNull();
  });

  /**
   * Their vocabulary is not ours. `created` and `started` are the two that
   * differ, and mapping them here is what keeps the provider's words out of
   * the database's check constraint.
   */
  it("maps the provider's status vocabulary onto ours", async () => {
    for (const [theirs, ours] of [
      ["created", "queued"],
      ["started", "running"],
      ["finished", "finished"],
      ["failed", "failed"],
      ["stopped", "stopped"],
    ] as const) {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ id: "t", status: theirs }), { status: 200 }),
      );
      const result = await taskStatus(ENV, "t");
      expect((result as { value: { status: string } }).value.status, theirs).toBe(ours);
    }
  });

  it("treats a status it has never heard of as still running rather than crashing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "t", status: "paused" }), { status: 200 }),
    );
    const result = await taskStatus(ENV, "t");
    expect((result as { value: { status: string } }).value.status).toBe("running");
  });
});

describe("stopTask", () => {
  it("patches the task with stop_task_and_session", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "t" }), { status: 200 }));
    const result = await stopTask(ENV, "t");
    expect(result).toEqual({ kind: "ok", value: null });
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: "stop_task_and_session",
    });
  });
});

describe("without a key", () => {
  it("refuses before it reaches the network", async () => {
    const result = await createTask({} as BrowserEnv, { task: "x".repeat(12) });
    expect(result.kind).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
