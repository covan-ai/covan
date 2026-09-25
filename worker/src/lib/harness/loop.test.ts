import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CompletionEvent, CompletionMessage } from "../completion";
import type { AgentTool, ToolContext, ToolResult } from "./registry";
import { runAgentTurn, parseArguments, NO_TOOLS_NOTICE, type PassUsage } from "./loop";
import { cap, MAX_STEP_EXCERPT_CHARS } from "./budget";

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
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
    },
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
  });
  return events;
}

/**
 * The transcript as each request actually saw it.
 *
 * `runAgentTurn` builds one `messages` array and mutates it for the whole
 * turn, so every entry in `streamCompletion.mock.calls` holds the SAME array —
 * read after the turn, they all show the final state. An assertion about what
 * the fourth request carried therefore has to be made against a copy taken
 * when that request was made, which is what this is.
 */
const sentTranscripts: CompletionMessage[][] = [];

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
  streamCompletion.mockImplementation(async function* (
    _env: unknown,
    req: { tools?: unknown[]; messages?: CompletionMessage[] },
  ) {
    sentTranscripts.push([...(req.messages ?? [])]);
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
  sentTranscripts.length = 0;
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
    expect(turn.usage).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      cachedTokens: 4,
      cacheWriteTokens: 6,
      // Summed like the rest. A loop that deliberates on every pass and one
      // that deliberates once are the same row total, which is why the split
      // below is kept as well.
      reasoningTokens: 8,
    });
  });

  it("keeps each pass's usage as well as the sum, which cannot be recovered from it", async () => {
    // Eight even passes and one enormous final pass sum identically. Only the
    // second is a caching problem, so the per-pass numbers are recorded at the
    // time rather than derived afterwards, which cannot be done.
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
    });

    expect(turn.passes).toEqual([
      { index: 0, prompt: 10, cached: 2, written: 3, completion: 5, reasoning: 4 },
      { index: 1, prompt: 10, cached: 2, written: 3, completion: 5, reasoning: 4 },
    ]);
    expect(turn.passes.reduce((n, p) => n + (p.prompt ?? 0), 0)).toBe(turn.usage.promptTokens);
  });

  it("says which pass asked for each tool, because a pass is what gets billed", async () => {
    // One pass asking for three tools is one prompt charge, not three. Without
    // the pass number a row in `message_steps` cannot be lined up with the
    // request that paid for it.
    scripted([
      pass("", [
        { id: "a", name: "search", arguments: "{}" },
        { id: "b", name: "search", arguments: "{}" },
      ]),
      pass("", [{ id: "c", name: "search", arguments: "{}" }]),
      pass("done"),
    ]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
    });

    expect(turn.steps.map((s) => s.pass)).toEqual([0, 0, 1]);
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
  it("stops after MAX_STEPS and tells the model in words that it is done", async () => {
    // A model that would ask forever.
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }])]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 3 },
    });
    expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(3);
    expect(turn.paused?.reason).toBe("budget");
    expect(
      (streamCompletion.mock.calls.at(-1)?.[1].messages as CompletionMessage[]).at(-1)?.content,
    ).toContain("used every tool call");
  });

  it("keeps the tool list on the budgeted pass, which is the dearest one to uncache", async () => {
    // Withholding the definitions is the one change that invalidates a prompt
    // cache from its first block — the provider renders tools before system
    // before messages, so a request whose tool list differs shares no prefix
    // with the one before it. Doing that on the budgeted pass meant paying full
    // price on the largest transcript of the whole turn. The words do the work
    // instead, and `mayAsk` throws away anything the model asks for anyway.
    scripted([
      pass("", [{ id: "c", name: "search", arguments: "{}" }]),
      pass("here is what I found"),
    ]);
    await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 1 },
    });

    expect(streamCompletion.mock.calls).toHaveLength(2);
    expect(streamCompletion.mock.calls[1][1]).toHaveProperty("tools");
  });

  it("asks once more without tools when the budgeted pass answered with nothing", async () => {
    // Being shown the tools means it can still reach for one and say nothing
    // else, and `mayAsk` can throw the call away but cannot supply the sentence
    // that should have been there — the person would get a turn that stops
    // dead. So the fallback is the old behaviour, kept for the case that needs
    // it: one request at full price rather than no answer. Nothing reached the
    // screen, so the second attempt is invisible rather than a repetition.
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }])]);
    await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 1 },
    });

    const calls = streamCompletion.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toHaveProperty("tools");
    // And once only. A second empty pass with nothing to reach for is a model
    // with nothing to say, not a model reaching for a tool.
    expect(calls[2][1]).not.toHaveProperty("tools");
  });

  it("does not ask twice when the budgeted pass did produce an answer", async () => {
    scripted([
      pass("", [{ id: "c", name: "search", arguments: "{}" }]),
      pass("done, though I ran out of steps"),
    ]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      budget: { maxSteps: 1 },
    });

    expect(streamCompletion.mock.calls).toHaveLength(2);
    expect(turn.text).toBe("done, though I ran out of steps");
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

  /**
   * The soft ceiling, and what happens instead of a confession.
   *
   * A turn that stops at its budget and says so is correct and useless: the
   * person asked a question, the agent used its allowance looking, and what
   * arrives is an apology. A leg is the allowance to carry on — and the whole
   * feature is that the model is told to carry on rather than told it is done,
   * because those are opposite instructions and the wrong one is invisible to
   * the person receiving it.
   */
  describe("legs past the soft ceiling", () => {
    /** A model that would ask forever, one call at a time. */
    const forever = () => scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }])]);
    const searching = () => [tool("search", async () => ({ kind: "ok", content: "x" }))];

    it("carries on past the soft ceiling without saying it ran out", async () => {
      forever();
      const turn = await runAgentTurn({
        ...base,
        tools: searching(),
        // Soft 2, one leg of 2, so the real ceiling is 4.
        budget: { maxSteps: 2, extraLegs: 1, legSteps: 2 },
      });

      expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(4);

      // The request made on the far side of the boundary: told to keep going,
      // and NOT told it is finished. Sending both would be sending a model two
      // opposite instructions and hoping for the second.
      const afterBoundary = sentTranscripts[2];
      expect(afterBoundary.at(-1)?.content).toContain("Do not stop");
      expect(afterBoundary.at(-1)?.content).not.toContain("used every tool call");

      // And it still has the tools. Withholding them is what invalidates a
      // prompt cache from its first block — see `toolsWithheld`.
      expect(streamCompletion.mock.calls[2][1]).toHaveProperty("tools");
    });

    it("says it once per leg, not once per pass", async () => {
      forever();
      await runAgentTurn({
        ...base,
        tools: searching(),
        budget: { maxSteps: 2, extraLegs: 1, legSteps: 4 },
      });

      // Every request past the boundary carries it, because the transcript is
      // re-sent whole. What must not happen is one transcript carrying it
      // twice, which is what a notice pushed per pass rather than per boundary
      // would produce.
      const perRequest = sentTranscripts.map(
        (messages) =>
          messages.filter((m) => m.role === "system" && String(m.content).includes("Do not stop"))
            .length,
      );
      expect(Math.max(...perRequest)).toBe(1);
    });

    it("still says it ran out once every leg is gone", async () => {
      forever();
      const turn = await runAgentTurn({
        ...base,
        tools: searching(),
        budget: { maxSteps: 2, extraLegs: 1, legSteps: 2 },
      });

      expect(turn.paused?.reason).toBe("budget");
      expect(
        (streamCompletion.mock.calls.at(-1)?.[1].messages as CompletionMessage[]).at(-1)?.content,
      ).toContain("used every tool call");
    });

    it("works out which leg a resumed turn is in from the steps alone", async () => {
      // The ceiling has to stay a pure function of `steps.length`: a turn can
      // pause for an approval at step 3 and come back with 3 in `stepsSoFar`,
      // and nothing is persisted about which leg it had reached. It also must
      // not re-announce a boundary the carried transcript already crossed.
      scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
      const turn = await runAgentTurn({
        ...base,
        tools: searching(),
        budget: { maxSteps: 2, extraLegs: 1, legSteps: 2 },
        stepsSoFar: [
          { index: 0, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
          { index: 1, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
          { index: 2, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
        ],
      });

      // Already inside the leg, so it gets the fourth step and stops there —
      // not a fresh budget, and not a second notice about a boundary that was
      // crossed before the pause.
      expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(4);
      const announced = sentTranscripts.flatMap((messages) =>
        messages.filter((m) => String(m.content).includes("Do not stop")),
      );
      expect(announced).toEqual([]);
    });

    /**
     * What a leg costs, and the one place it is worth paying.
     *
     * Past the soft ceiling, subrequests stop being what binds and the context
     * window starts. A step's result is re-sent on every later pass, so a turn
     * running into its legs is carrying the most transcript it will ever carry
     * at exactly the point it can least afford to. Trimming the results it has
     * finished with buys the room.
     *
     * At the boundary, once — not continuously. Rewriting an earlier message
     * invalidates the prompt cache from that point, so doing it per pass would
     * pay that on every pass; doing it here means one leg pays once, and a turn
     * that never crosses the boundary never pays at all.
     */
    describe("making room for the leg", () => {
      /**
       * A tool whose answers are far too big to keep re-sending.
       *
       * Comfortably over `MAX_STEP_EXCERPT_CHARS` (2,000), which is the floor
       * trimming cuts to — a result already smaller than that has nothing to
       * give back and is left alone.
       */
      const verbose = () => [
        tool("search", async () => ({ kind: "ok", content: "x".repeat(5_000) })),
      ];

      it("trims the results it has finished with, and says it did", async () => {
        forever();
        await runAgentTurn({
          ...base,
          tools: verbose(),
          budget: { maxSteps: 4, extraLegs: 1, legSteps: 2, maxOutputChars: 5_000 },
        });

        // The transcript as the first request past the boundary saw it.
        const afterBoundary = sentTranscripts[4];
        const results = afterBoundary.filter((m) => m.role === "tool");
        // Four results by then: the two oldest cut to the 2,000-character
        // floor, the two it is working through left whole at 5,000.
        expect(results.map((m) => m.content.length > 3_000)).toEqual([false, false, true, true]);
        // And cut with `cap`, so the model is told rather than quietly handed
        // a truncation it would mistake for the whole answer.
        expect(results[0].content).toContain("[trimmed:");
      });

      it("leaves an ordinary turn's transcript alone", async () => {
        // The turn that never reaches its budget is the common one, and it must
        // not pay a cache invalidation for a ceiling it never met.
        scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
        await runAgentTurn({
          ...base,
          tools: verbose(),
          budget: { maxSteps: 4, extraLegs: 1, legSteps: 2, maxOutputChars: 5_000 },
        });

        const everyResult = sentTranscripts.flatMap((messages) =>
          messages.filter((m) => m.role === "tool"),
        );
        expect(everyResult.every((m) => !m.content.includes("[trimmed:"))).toBe(true);
      });

      it("trims each result once, however many boundaries the turn crosses", async () => {
        // Two legs means two boundaries, and a result cut at the first must not
        // be cut again at the second — `cap` would nest its own notice inside
        // the text it already added.
        forever();
        await runAgentTurn({
          ...base,
          tools: verbose(),
          budget: { maxSteps: 2, extraLegs: 2, legSteps: 2, maxOutputChars: 5_000 },
        });

        const last = sentTranscripts.at(-1) ?? [];
        for (const result of last.filter((m) => m.role === "tool")) {
          expect(result.content.split("[trimmed:").length - 1).toBeLessThanOrEqual(1);
        }
      });
    });

    /**
     * The other ceiling, and why steps alone are not enough.
     *
     * A step budget bounds how many times a turn reaches outside. It does not
     * bound what those calls cost: one tool that returns a large result, re-sent
     * on every later pass, can spend a month's allowance inside a budget it
     * never exceeds. Measured on the incident this work came from — an 8-step
     * turn charging 131,868 prompt tokens, 88% of them cache reads.
     *
     * Enforced here rather than in the route for the same reason `maxSteps` is:
     * this is the only place that sees the running total while the turn is
     * still running.
     */
    describe("the token ceiling", () => {
      it("stops the turn, and says which ceiling it was", async () => {
        forever();
        const turn = await runAgentTurn({
          ...base,
          tools: searching(),
          // A pass costs 15 (10 prompt + 5 completion), so the third crosses.
          budget: { maxSteps: 50, maxTurnTokens: 40 },
        });

        expect(turn.paused?.reason).toBe("tokens");
        // Not the step sentence. The two ceilings are different facts, and a
        // turn that stopped on cost telling the person it ran out of tool calls
        // sends them to narrow the wrong thing.
        const told = (sentTranscripts.at(-1) ?? []).filter((m) => m.role === "system");
        expect(String(told.at(-1)?.content)).toContain("token");
        expect(String(told.at(-1)?.content)).not.toContain("every tool call allowed");
      });

      it("bills what it spent, because a ceiling is not a way to avoid the bill", async () => {
        forever();
        const turn = await runAgentTurn({
          ...base,
          tools: searching(),
          budget: { maxSteps: 50, maxTurnTokens: 40 },
        });

        expect(turn.usage.promptTokens).toBeGreaterThan(0);
        expect(turn.passes.length).toBeGreaterThan(0);
        expect((turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0)).toBeGreaterThan(
          40,
        );
      });

      it("answers the calls it refuses, so the next request is not a 400", async () => {
        // The same rule the step ceiling follows: a tool call left unanswered
        // in the transcript is a 400 from the provider, not a smaller turn.
        scripted([
          pass("", [
            { id: "a", name: "search", arguments: "{}" },
            { id: "b", name: "search", arguments: "{}" },
          ]),
        ]);
        const turn = await runAgentTurn({
          ...base,
          tools: searching(),
          budget: { maxSteps: 50, maxTurnTokens: 1 },
        });

        expect(turn.steps.every((s) => s.status === "refused")).toBe(true);
        const answered = (sentTranscripts.at(-1) ?? []).filter((m) => m.role === "tool");
        expect(answered).toHaveLength(2);
      });

      it("leaves a turn under the ceiling completely alone", async () => {
        scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
        const turn = await runAgentTurn({
          ...base,
          tools: searching(),
          budget: { maxSteps: 50, maxTurnTokens: 1_000_000 },
        });
        expect(turn.paused).toBeUndefined();
        expect(turn.text).toBe("done");
      });
    });

    /**
     * The boundary that is crossed while the turn is stopping to ask.
     *
     * A confirmation returns from the middle of the batch, before the once-per-
     * pass boundary code runs — so a pass whose last call crosses the soft
     * ceiling AND needs approval ends with no notice sent. What then decides
     * whether the resumed half ever gets one is how it works out where it is,
     * and counting steps is the wrong way: the boundary was crossed, so the
     * step count says "already announced" about a notice nobody sent.
     *
     * This is the population legs exist for — long turns that reach for a
     * connected app — so getting it wrong turns the feature off exactly where
     * it was meant to work.
     */
    describe("a boundary crossed by the call that stops to ask", () => {
      const asking = () => [
        tool("search", async () => ({ kind: "ok", content: "x" })),
        tool("send", async () => ({
          kind: "needs_confirmation",
          summary: "Send it?",
          proposal: null,
        })),
      ];

      it("tells the resumed half to keep going, not to wrap up", async () => {
        // Two steps, the second of which pauses — so the soft ceiling of 2 is
        // reached by the very call that parks the turn.
        scripted([
          pass("", [
            { id: "a", name: "search", arguments: "{}" },
            { id: "b", name: "send", arguments: "{}" },
          ]),
        ]);
        const parked = await runAgentTurn({
          ...base,
          tools: asking(),
          budget: { maxSteps: 2, extraLegs: 1, legSteps: 2 },
        });
        expect(parked.paused?.reason).toBe("confirmation");
        expect(parked.steps).toHaveLength(2);

        // The resume, the way `/chat/confirm/:id` does it: the parked messages
        // with the approved call answered, and the steps already spent.
        sentTranscripts.length = 0;
        scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
        await runAgentTurn({
          ...base,
          request: {
            ...base.request,
            messages: [
              ...(parked.paused?.messages ?? []),
              { role: "tool" as const, toolCallId: "b", content: "sent" },
            ],
          },
          tools: asking(),
          budget: { maxSteps: 2, extraLegs: 1, legSteps: 2 },
          stepsSoFar: parked.steps.map((s) => ({ ...s, status: "ok" as const })),
        });

        const told = sentTranscripts.flatMap((messages) =>
          messages.filter((m) => String(m.content).includes("Do not stop")),
        );
        expect(told.length).toBeGreaterThan(0);
      });
    });

    it("does not cut a result twice across a pause, which would understate its size", async () => {
      // `cap` writes the original length into the text it appends. Cutting an
      // already-cut result reports the cut size as the original, so the model is
      // told a large result was small — and the guard that prevents it cannot be
      // a set of indices, because a resume is a fresh call with a fresh set and
      // the same messages.
      const already = cap("y".repeat(5_000), MAX_STEP_EXCERPT_CHARS);
      scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
      await runAgentTurn({
        ...base,
        request: {
          ...base.request,
          messages: [
            ...base.request.messages,
            { role: "assistant" as const, content: "", toolCalls: [] },
            { role: "tool" as const, toolCallId: "old", content: already },
          ],
        },
        tools: [tool("search", async () => ({ kind: "ok", content: "z".repeat(5_000) }))],
        // Soft 1 with two legs of 1, and one step already spent, so this turn
        // crosses a boundary it did not itself announce — which is the shape a
        // resume arrives in.
        budget: { maxSteps: 1, extraLegs: 2, legSteps: 1, maxOutputChars: 5_000 },
        stepsSoFar: [
          { index: 0, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
        ],
      });

      const carried = (sentTranscripts.at(-1) ?? []).find((m) => m.content.startsWith("yyy"));
      expect(carried?.content).toBe(already);
      expect((carried?.content ?? "").split("[trimmed:").length - 1).toBe(1);
    });

    it("has no legs unless a caller asks for them", async () => {
      // The default is load-bearing: `SCHEDULED_MAX_STEPS` and every existing
      // budget case pass a bare `maxSteps`, and all of them have to keep
      // meaning exactly what they meant.
      forever();
      const turn = await runAgentTurn({ ...base, tools: searching(), budget: { maxSteps: 2 } });
      expect(turn.steps.filter((s) => s.status === "ok")).toHaveLength(2);
      expect(turn.paused?.reason).toBe("budget");
    });
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

  it("numbers a resumed turn's passes after the ones already spent", async () => {
    // A resume is a fresh sequence of model calls against a transcript that
    // already has steps in it. Starting again at zero would put two different
    // requests under the same `pass_index` on one message.
    scripted([pass("", [{ id: "c", name: "search", arguments: "{}" }]), pass("done")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      stepsSoFar: [
        {
          index: 0,
          pass: 2,
          tool: "search",
          request: {},
          resultExcerpt: "",
          status: "ok",
          durationMs: 1,
        },
      ],
    });

    expect(turn.steps[1].pass).toBe(3);
    expect(turn.passes.map((p) => p.index)).toEqual([3, 4]);
  });

  it("starts a resumed turn at zero when the parked steps predate pass numbering", async () => {
    // `paused_turns.steps` is JSON written by an older build, so the field can
    // simply be absent. The -1 floor is what makes that fall through to zero
    // rather than to NaN.
    scripted([pass("done")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "x" }))],
      stepsSoFar: [
        { index: 0, tool: "search", request: {}, resultExcerpt: "", status: "ok", durationMs: 1 },
      ],
    });

    expect(turn.passes.map((p) => p.index)).toEqual([0]);
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

  it("records how much of a trimmed result the model was actually shown", async () => {
    // `resultExcerpt` stops at MAX_STEP_EXCERPT_CHARS and `resultChars` does
    // not, which is the whole point of having both: without the length, every
    // result past the excerpt ceiling looks the same size from the outside and
    // the tool-output budget cannot be tuned against anything.
    scripted([pass("", [{ id: "c", name: "big", arguments: "{}" }]), pass("ok")]);
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("big", async () => ({ kind: "ok", content: "x".repeat(500) }))],
      budget: { maxOutputChars: 50 },
    });
    const sent = (streamCompletion.mock.calls[1][1].messages as CompletionMessage[])[2];
    expect(turn.steps[0].resultChars).toBe(sent.content.length);
    // Bigger than the 50 it was capped to, because `cap` appends the sentence
    // saying it trimmed — and that sentence is in front of the model too.
    expect(turn.steps[0].resultChars).toBeGreaterThan(50);
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

/**
 * What survives a turn that throws.
 *
 * The loop reports its steps by returning them, so a turn that does not return
 * reports nothing — and the caller's `steps` variable is still empty in its
 * `catch`. That was survivable when a turn was one model call. It stopped
 * being survivable when a turn became sixteen: a dropped connection on a late
 * pass discards every tool call before it, and those calls really ran.
 */
describe("a turn that dies with work already behind it", () => {
  it("hands each step to onStep as it settles", async () => {
    scripted([
      pass("Looking.", [{ id: "c1", name: "search", arguments: '{"q":"a"}' }]),
      pass("Done."),
    ]);
    const seen: Array<{ tool: string; status: string }> = [];
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
      onStep: (step) => seen.push({ tool: step.tool, status: step.status }),
    });
    expect(seen).toEqual([{ tool: "search", status: "ok" }]);
    // The same steps by both roads, so a caller can use either without
    // wondering which one is authoritative.
    expect(turn.steps.map((s) => s.tool)).toEqual(["search"]);
  });

  it("keeps the steps the caller collected when a later pass throws", async () => {
    let call = 0;
    streamCompletion.mockImplementation(async function* (
      _env: unknown,
      req: { tools?: unknown[] },
    ) {
      call += 1;
      if (call === 1) {
        for (const e of pass("Looking.", [{ id: "c1", name: "search", arguments: "{}" }])) {
          if (e.type === "tools" && !req.tools) continue;
          yield e;
        }
        return;
      }
      // The shape the first production failure had: the request to the model
      // fails outright, after a tool has already run and been paid for.
      throw new Error("Connection error.");
    });

    const collected: string[] = [];
    await expect(
      runAgentTurn({
        ...base,
        tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
        onStep: (step) => collected.push(step.tool),
      }),
    ).rejects.toThrow("Connection error.");

    // The turn is gone; the record of what it did is not.
    expect(collected).toEqual(["search"]);
  });

  /**
   * The same argument as `onStep`, about the other half of what a turn
   * produces. `turn.usage` only exists once this function returns, so a turn
   * that throws reports no tokens at all — and the route's salvage then writes
   * an assistant row with every token column null and bills nothing for model
   * calls that really happened. This is the only copy that survives the throw.
   */
  it("hands each pass's usage to onPass as it lands, so a throw still has numbers", async () => {
    let call = 0;
    streamCompletion.mockImplementation(async function* (
      _env: unknown,
      req: { tools?: unknown[] },
    ) {
      call += 1;
      if (call === 1) {
        for (const e of pass("Looking.", [{ id: "c1", name: "search", arguments: "{}" }])) {
          if (e.type === "tools" && !req.tools) continue;
          yield e;
        }
        return;
      }
      throw new Error("Connection error.");
    });

    const billed: Array<{ index: number; prompt: number | null }> = [];
    await expect(
      runAgentTurn({
        ...base,
        tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
        onPass: (usage) => billed.push({ index: usage.index, prompt: usage.prompt }),
      }),
    ).rejects.toThrow("Connection error.");

    expect(billed).toEqual([{ index: 0, prompt: 10 }]);
  });

  it("gives onPass the same entries the turn returns, so neither is authoritative", async () => {
    scripted([pass("Looking.", [{ id: "c1", name: "search", arguments: "{}" }]), pass("Done.")]);
    const billed: PassUsage[] = [];
    const turn = await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
      onPass: (usage) => billed.push(usage),
    });
    expect(billed).toEqual(turn.passes);
    expect(billed.map((p) => p.index)).toEqual([0, 1]);
  });

  it("reports a refused step too, so a spent budget is not silently lost", async () => {
    scripted([
      pass("Looking.", [
        { id: "c1", name: "search", arguments: "{}" },
        { id: "c2", name: "search", arguments: "{}" },
      ]),
    ]);
    const statuses: string[] = [];
    await runAgentTurn({
      ...base,
      tools: [tool("search", async () => ({ kind: "ok", content: "found" }))],
      budget: { maxSteps: 1 },
      onStep: (step) => statuses.push(step.status),
    });
    expect(statuses).toEqual(["ok", "refused"]);
  });
});
