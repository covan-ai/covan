import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CompletionEvent, CompletionMessage } from "../completion";
import type { AgentTool, ToolContext, ToolResult } from "./registry";
import { runAgentTurn, parseArguments, NO_TOOLS_NOTICE } from "./loop";

/**
 * The loop, driven by a scripted model.
 *
 * `streamCompletion` is mocked rather than the SDKs, which is a deliberate
 * step up from `completion.test.ts` next door: that file proves the two
 * providers are spoken to correctly, and this one has no business re-proving
 * it. What is under test here is the sequence — ask, run, ask again, stop —
 * and the four ways it is allowed to stop.
 */

const streamCompletion = vi.fn();
vi.mock("../completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../completion")>();
  return {
    ...actual,
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
  };
});

/** One scripted pass: what the model says, and what it asks for. */
function pass(
  text: string,
  calls: Array<{ id: string; name: string; arguments: string }> = [],
): CompletionEvent[] {
  const events: CompletionEvent[] = [];
  if (text) events.push({ type: "delta", text });
  if (calls.length > 0) events.push({ type: "tools", calls });
  events.push({
    type: "end",
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
  });
  return events;
}

/**
 * Replay the scripted passes, repeating the last one forever.
 *
 * Repeating is what makes the budget testable: a model that would ask again
 * every time it is allowed to is exactly the case the budget exists for. So
 * the fake has to honour the one thing the real provider honours — a request
 * with no tools on it cannot come back with a tool call — or the test would
 * be asserting against something no provider does.
 */
function scripted(passes: CompletionEvent[][]) {
  let i = 0;
  streamCompletion.mockImplementation(async function* (_env: unknown, req: { tools?: unknown[] }) {
    const events = passes[Math.min(i, passes.length - 1)];
    i += 1;
    for (const e of events) {
      if (e.type === "tools" && !req.tools) continue;
      yield e;
    }
  });
}

const ctx = {} as ToolContext;

function tool(
  name: string,
  run: (args: unknown, ctx: ToolContext) => Promise<ToolResult>,
  extra: Partial<AgentTool> = {},
): AgentTool {
  return {
    name,
    description: name,
    input: { type: "object", properties: {} },
    destructive: false,
    isConfigured: () => true,
    run,
    ...extra,
  };
}

const base = {
  env: { OPENAI_API_KEY: "sk" },
  request: { model: "gpt-4.1", messages: [{ role: "user" as const, content: "go" }] },
  ctx,
};

beforeEach(() => {
  streamCompletion.mockReset();
});

describe("a turn that asks for nothing", () => {
  it("is one pass, and looks exactly like a completion", async () => {
    scripted([pass("the answer")]);
    const turn = await runAgentTurn({ ...base, tools: [] });
    expect(turn.text).toBe("the answer");
    expect(turn.steps).toEqual([]);
    expect(turn.paused).toBeUndefined();
    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });

  it("sends no tools field when there are none to send", async () => {
    scripted([pass("hi")]);
    await runAgentTurn({ ...base, tools: [] });
    expect(streamCompletion.mock.calls[0][1]).not.toHaveProperty("tools");
  });
});

describe("a turn that asks for one thing", () => {
  it("runs it, feeds the result back, and answers on the second pass", async () => {
    scripted([
      pass("Let me look.", [{ id: "c1", name: "search", arguments: '{"query":"leave"}' }]),
      pass("Twenty days."),
    ]);
    const run = vi.fn(async () => ({ kind: "ok" as const, content: "20 days" }));
    const turn = await runAgentTurn({ ...base, tools: [tool("search", run)] });

    expect(run).toHaveBeenCalledWith({ query: "leave" }, expect.anything());
    expect(turn.text).toBe("Let me look.\n\nTwenty days.");
    expect(turn.steps).toEqual([
      expect.objectContaining({
        index: 0,
        tool: "search",
        status: "ok",
        request: { query: "leave" },
      }),
    ]);

    // The second request carries the whole exchange, so the model can see
    // what it asked for and what came back.
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second[1]).toMatchObject({ role: "assistant", content: "Let me look." });
    expect(second[2]).toEqual({ role: "tool", toolCallId: "c1", content: "20 days" });
  });

  it("sums usage across every pass rather than keeping the last one", async () => {
    scripted([pass("a", [{ id: "c1", name: "search", arguments: "{}" }]), pass("b")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
    });
    expect(turn.usage).toEqual({ promptTokens: 20, completionTokens: 10, cachedTokens: 4 });
  });

  it("emits a step twice — once running, once settled", async () => {
    scripted([pass("", [{ id: "c1", name: "search", arguments: "{}" }]), pass("done")]);
    const events: Array<{ type: string; status?: string }> = [];
    await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === "step").map((e) => e.status)).toEqual(["running", "ok"]);
  });

  it("separates one pass's words from the next with a blank line, as a delta", async () => {
    scripted([pass("First.", [{ id: "c1", name: "search", arguments: "{}" }]), pass("Second.")]);
    const deltas: string[] = [];
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      onEvent: (e) => {
        if (e.type === "delta") deltas.push(e.text);
      },
    });
    // What was shown and what was kept are the same string, which is the
    // whole reason the separator is emitted rather than only appended.
    expect(deltas.join("")).toBe(turn.text);
  });
});

describe("when a tool goes wrong", () => {
  it("gives the model the error rather than failing the turn", async () => {
    scripted([pass("", [{ id: "c1", name: "search", arguments: "{}" }]), pass("I could not.")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "error", message: "upstream is down" }))],
    });
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: "error: upstream is down",
    });
    expect(turn.steps[0].status).toBe("failed");
    expect(turn.text).toBe("I could not.");
  });

  it("turns a throw into the same thing, so one bad tool cannot end a turn", async () => {
    scripted([pass("", [{ id: "c1", name: "search", arguments: "{}" }]), pass("ok")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [
        tool("search", async () => {
          throw new Error("boom");
        }),
      ],
    });
    expect(turn.steps[0].status).toBe("failed");
    expect(turn.text).toBe("ok");
  });

  it("names the tools that do exist when the model invents one", async () => {
    scripted([pass("", [{ id: "c1", name: "teleport", arguments: "{}" }]), pass("sorry")]);
    await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
    });
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second[2].content).toContain("no tool named teleport");
    expect(second[2].content).toContain("search");
  });

  it("refuses to run a call whose arguments did not parse", async () => {
    scripted([pass("", [{ id: "c1", name: "search", arguments: '{"query":' }]), pass("retry")]);
    const run = vi.fn(async () => ({ kind: "ok" as const, content: "x" }));
    await runAgentTurn({ ...base, tools: [tool("search", run)] });
    expect(run).not.toHaveBeenCalled();
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second[2].content).toContain("not valid JSON");
  });
});

describe("the budget", () => {
  it("stops after MAX_STEPS and asks for an answer with no tools attached", async () => {
    // A model that would ask forever.
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }])]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 3 },
    });
    expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(3);
    expect(turn.paused?.reason).toBe("budget");
    // The last request is the one that has to produce words, so it must not
    // offer the model another way out.
    const last = streamCompletion.mock.calls.at(-1)?.[1];
    expect(last).not.toHaveProperty("tools");
    expect((last.messages as CompletionMessage[]).at(-1)?.content).toContain(
      "used every tool call",
    );
  });

  it("answers the calls it refused, so the next request is not a 400", async () => {
    scripted([
      pass("", [
        { id: "a", name: "search", arguments: "{}" },
        { id: "b", name: "search", arguments: "{}" },
      ]),
      pass("done"),
    ]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 1 },
    });
    expect(turn.steps.map((s) => s.status)).toEqual(["ok", "refused"]);
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("continues a resumed turn's budget rather than starting a fresh one", async () => {
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }])]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 2 },
      stepsSoFar: [
        { index: 0, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
      ],
    });
    // One already spent, so one more and then the budget instruction.
    expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(2);
  });

  it("gives up on a tool that hangs and tells the model why", async () => {
    scripted([pass("", [{ id: "c", name: "slow", arguments: "{}" }]), pass("gave up")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("slow", () => new Promise(() => {}))],
      budget: { toolTimeoutMs: 20 },
    });
    expect(turn.steps[0].status).toBe("failed");
    expect(turn.steps[0].resultExcerpt).toContain("timed out");
  });

  it("trims a result that would otherwise be paid for on every later pass", async () => {
    scripted([pass("", [{ id: "c", name: "big", arguments: "{}" }]), pass("ok")]);
    await runAgentTurn({
      ...base,
      tools: [tool("big", async () => ({ kind: "ok", content: "x".repeat(500) }))],
      budget: { maxOutputChars: 50 },
    });
    const second = streamCompletion.mock.calls[1][1].messages as CompletionMessage[];
    expect(second[2].content).toContain("trimmed");
    expect(second[2].content.length).toBeLessThan(200);
  });
});

describe("a turn that stops to ask", () => {
  it("returns paused with everything a resume needs, and leaves the call unanswered", async () => {
    scripted([pass("I can set that up.", [{ id: "c1", name: "schedule", arguments: "{}" }])]);
    const turn = await runAgentTurn({
      ...base,
      tools: [
        tool("schedule", async () => ({
          kind: "needs_confirmation",
          summary: "Create a routine?",
          proposal: { cron: "0 9 * * 1" },
        })),
      ],
    });

    expect(turn.paused).toMatchObject({
      reason: "confirmation",
      call: { id: "c1", name: "schedule" },
      summary: "Create a routine?",
      proposal: { cron: "0 9 * * 1" },
    });
    // The assistant turn that asked is in the parked messages; the answer to
    // it is not, because it has not happened.
    expect(turn.paused?.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(turn.paused?.messages.some((m) => m.role === "tool")).toBe(false);
    expect(turn.steps[0].status).toBe("pending");
    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });

  it("runs the tool for real once the context says it was confirmed", async () => {
    scripted([pass("", [{ id: "c1", name: "schedule", arguments: "{}" }]), pass("Created.")]);
    const run = vi.fn(async (_args: unknown, c: ToolContext) =>
      c.confirmed
        ? ({ kind: "ok", content: "created" } as ToolResult)
        : ({ kind: "needs_confirmation", summary: "?", proposal: {} } as ToolResult),
    );
    const turn = await runAgentTurn({
      ...base,
      ctx: { confirmed: true } as ToolContext,
      tools: [tool("schedule", run)],
    });
    expect(turn.paused).toBeUndefined();
    expect(turn.text).toBe("Created.");
  });
});

describe("a model that cannot be given tools", () => {
  it("runs the turn without them and tells the model so, rather than 400ing", async () => {
    scripted([pass("I cannot look that up.")]);
    const turn = await runAgentTurn({
      ...base,
      // Unknown to `lib/models.ts`, which is every id under OPENAI_BASE_URL.
      request: { ...base.request, model: "llama-3.1-70b" },
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
    });
    const sent = streamCompletion.mock.calls[0][1];
    expect(sent).not.toHaveProperty("tools");
    expect((sent.messages as CompletionMessage[]).at(-1)?.content).toBe(NO_TOOLS_NOTICE);
    expect(turn.text).toBe("I cannot look that up.");
  });
});

describe("an approval scoped to a connection for the rest of the turn", () => {
  /** What the loop handed the tool, call by call. */
  function recordingRunTool(seen: Array<string[] | undefined>): AgentTool {
    return tool(
      "run_tool",
      async (_args, toolCtx) => {
        seen.push(toolCtx.approvedConnections);
        return { kind: "ok", content: "done" };
      },
      { destructive: true },
    );
  }

  it("unlocks a connection for the next call once one has landed", async () => {
    const seen: Array<string[] | undefined> = [];
    scripted([
      pass("", [{ id: "c1", name: "run_tool", arguments: '{"connectionId":"conn-1"}' }]),
      pass("", [{ id: "c2", name: "run_tool", arguments: '{"connectionId":"conn-1"}' }]),
      pass("done"),
    ]);
    await runAgentTurn({ ...base, tools: [recordingRunTool(seen)] });

    // Nothing to go on for the first call — the tool is what asks. By the
    // second, the first has landed as `ok`, which is the only status a
    // `run_tool` step can reach without an approval behind it.
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["conn-1"]);
  });

  it("carries an approval across a resume, without a schema or a chat.ts change", async () => {
    // What `routes/chat.ts` hands back after somebody approves: the resolved
    // step, with `confirmed` deliberately reset to false.
    const seen: Array<string[] | undefined> = [];
    scripted([
      pass("", [{ id: "c2", name: "run_tool", arguments: '{"connectionId":"conn-1"}' }]),
      pass("done"),
    ]);
    await runAgentTurn({
      ...base,
      tools: [recordingRunTool(seen)],
      stepsSoFar: [
        {
          index: 0,
          tool: "run_tool",
          request: { connectionId: "conn-1", slug: "GMAIL_SEND_EMAIL" },
          resultExcerpt: "done",
          status: "ok",
          durationMs: 5,
        },
      ],
    });
    expect(seen[0]).toEqual(["conn-1"]);
  });

  it("does not read a refused or failed call as an approval", async () => {
    // The conservative direction, and it is forced rather than chosen: a step
    // that failed before reaching the gate and one that failed after passing it
    // are indistinguishable from here.
    const seen: Array<string[] | undefined> = [];
    scripted([
      pass("", [{ id: "c2", name: "run_tool", arguments: '{"connectionId":"conn-1"}' }]),
      pass("done"),
    ]);
    await runAgentTurn({
      ...base,
      tools: [recordingRunTool(seen)],
      stepsSoFar: [
        {
          index: 0,
          tool: "run_tool",
          request: { connectionId: "conn-1" },
          resultExcerpt: "declined",
          status: "refused",
          durationMs: 1,
        },
        {
          index: 1,
          tool: "run_tool",
          request: { connectionId: "conn-2" },
          resultExcerpt: "500",
          status: "failed",
          durationMs: 1,
        },
      ],
    });
    expect(seen[0]).toEqual([]);
  });

  it("does not let another tool's step unlock anything", async () => {
    const seen: Array<string[] | undefined> = [];
    scripted([
      pass("", [{ id: "c2", name: "run_tool", arguments: '{"connectionId":"conn-1"}' }]),
      pass("done"),
    ]);
    await runAgentTurn({
      ...base,
      tools: [recordingRunTool(seen)],
      stepsSoFar: [
        {
          index: 0,
          tool: "http_request",
          request: { connectionId: "conn-1", path: "/x" },
          resultExcerpt: "{}",
          status: "ok",
          durationMs: 1,
        },
      ],
    });
    expect(seen[0]).toEqual([]);
  });
});

describe("the label a person reads on a step", () => {
  it("shows the operation rather than the connection's uuid", async () => {
    const labels: string[] = [];
    scripted([
      pass("", [
        {
          id: "c1",
          name: "run_tool",
          arguments: '{"connectionId":"8f3a-1111","slug":"GMAIL_SEND_EMAIL"}',
        },
      ]),
      pass("done"),
    ]);
    await runAgentTurn({
      ...base,
      tools: [tool("run_tool", async () => ({ kind: "ok", content: "sent" }))],
      onEvent: (event) => {
        if (event.type === "step") labels.push(event.label);
      },
    });
    expect(labels[0]).toBe("run_tool · GMAIL_SEND_EMAIL");
  });
});

describe("parseArguments", () => {
  it("accepts nothing at all, which is a legitimate call", () => {
    expect(parseArguments("")).toEqual({ ok: true, args: {} });
  });

  it("refuses an array, which is not a set of named arguments", () => {
    expect(parseArguments("[1,2]")).toMatchObject({ ok: false });
  });

  it("refuses a half-written object rather than guessing at it", () => {
    expect(parseArguments('{"a":')).toMatchObject({ ok: false });
  });
});
