import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { AgentRunInput } from "./executor";
import { MAX_STEPS, SCHEDULED_MAX_STEPS } from "../harness/budget";

/**
 * A scheduled run with tools, and the three things about it that are not the
 * chat path.
 *
 * Nobody is watching, so a tool that would ask a person does not get to; the
 * relevance decision cannot ride along in the same call, because a request
 * that demands JSON and offers tools gets neither; and a workspace with
 * nothing connected must fall all the way back to the single call it always
 * made, rather than paying for a loop that has nothing to loop over.
 */

const capabilitiesFor = vi.fn();
const runAgentTurn = vi.fn();
const complete = vi.fn();

vi.mock("../harness/available", () => ({
  capabilitiesFor: (input: unknown) => capabilitiesFor(input),
}));
vi.mock("../harness/loop", () => ({ runAgentTurn: (opts: unknown) => runAgentTurn(opts) }));
vi.mock("../completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../completion")>();
  return { ...actual, complete: (env: unknown, req: unknown) => complete(env, req) };
});

const { runRoutineWithTools } = await import("./agent-run");

const env = { OPENAI_API_KEY: "sk" } as RoutineEnv;
const db = {} as SupabaseClient;

const input: AgentRunInput = {
  persona: "You are our PM.",
  model: "gpt-4.1",
  instruction: "Report on yesterday's orders.",
  items: [],
  ragBlock: "",
  mayDecline: false,
  agentId: "a1",
  workspaceId: "w1",
  userId: "u1",
};

const TOOL = { name: "query_database" } as never;

beforeEach(() => {
  capabilitiesFor.mockReset();
  runAgentTurn.mockReset();
  complete.mockReset();
  capabilitiesFor.mockResolvedValue({ tools: [TOOL], manifest: "Connected services: …" });
  runAgentTurn.mockResolvedValue({
    text: "Forty orders.",
    usage: { promptTokens: 100, completionTokens: 40, cachedTokens: 0 },
    steps: [],
    finishReason: "stop",
  });
});

describe("runRoutineWithTools", () => {
  it("answers null when this workspace has nothing for a tool to point at", async () => {
    capabilitiesFor.mockResolvedValue({ tools: [], manifest: "" });
    expect(await runRoutineWithTools(env, db)(input, env)).toBeNull();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  /**
   * The free half of the same question. On the cron Worker a read is a
   * subrequest, so a tick answers this once for its whole batch and hands
   * the answer down — see `workspacesWithConnections` in the dispatcher.
   */
  it("answers null without reading anything when the tick already said no", async () => {
    const out = await runRoutineWithTools(env, db, () => false)(input, env);
    expect(out).toBeNull();
    expect(capabilitiesFor).not.toHaveBeenCalled();
  });

  it("still looks when the tick said this workspace has something", async () => {
    await runRoutineWithTools(env, db, () => true)(input, env);
    expect(capabilitiesFor).toHaveBeenCalledTimes(1);
  });

  it("does not offer the tools a run with nobody watching could never finish", async () => {
    await runRoutineWithTools(env, db)(input, env);
    // `schedule_job` would ask a person and a tick has nobody to ask;
    // `send_email` duplicates the delivery the routine is about to make. Not
    // offering them also saves the delivery_channels read behind them.
    expect(capabilitiesFor.mock.calls[0][0]).toMatchObject({ surface: "schedule" });
  });

  it("runs the loop and reports what the whole turn cost", async () => {
    const out = await runRoutineWithTools(env, db)(input, env);
    expect(out).toEqual({ text: "Forty orders.", tokens: 140, declined: false });
  });

  it("tells the agent nobody is watching, and names what it can reach", async () => {
    await runRoutineWithTools(env, db)(input, env);
    const system = runAgentTurn.mock.calls[0][0].request.messages[0].content as string;
    expect(system).toContain("You are our PM.");
    expect(system).toContain("Nobody is watching");
    expect(system).toContain("Connected services");
  });

  it("resolves every id from the routine rather than letting the model send one", async () => {
    await runRoutineWithTools(env, db)(input, env);
    expect(runAgentTurn.mock.calls[0][0].ctx).toMatchObject({
      workspaceId: "w1",
      agentId: "a1",
      userId: "u1",
    });
  });

  it("does not pay for a readable account of reasoning nobody will read", async () => {
    await runRoutineWithTools(env, db)(input, env);
    expect(runAgentTurn.mock.calls[0][0].request.showThinking).toBeUndefined();
  });

  /**
   * The one number the two surfaces are allowed to disagree about, and the
   * only thing holding the cron Worker inside Workers Free's fifty
   * subrequests. `dispatcher.ts` does that arithmetic against `BATCH_SIZE`;
   * a routine taking chat's sixteen steps would break it three routines into
   * a tick, and the symptom is the last ones failing at a ceiling with nothing
   * in their run log to explain it.
   */
  it("keeps the smaller step budget, which chat no longer has", async () => {
    await runRoutineWithTools(env, db)(input, env);
    expect(runAgentTurn.mock.calls[0][0].budget).toEqual({ maxSteps: SCHEDULED_MAX_STEPS });
    expect(SCHEDULED_MAX_STEPS).toBeLessThan(MAX_STEPS);
  });

  it("asks whether to send as a separate turn, never alongside the tools", async () => {
    complete.mockResolvedValue({
      text: JSON.stringify({ relevant: false, summary: "" }),
      usage: { promptTokens: 20, completionTokens: 5, cachedTokens: 0 },
    });
    const out = await runRoutineWithTools(env, db)({ ...input, mayDecline: true }, env);

    expect(out).toMatchObject({ declined: true, tokens: 165 });
    // The turn that did the work was never asked for JSON, and the turn that
    // decided was never offered a tool.
    expect(runAgentTurn.mock.calls[0][0].request.json).toBeUndefined();
    expect(complete.mock.calls[0][1].json).toBe(true);
  });

  it("does not ask the question at all when the run may not decline", async () => {
    await runRoutineWithTools(env, db)(input, env);
    expect(complete).not.toHaveBeenCalled();
  });

  it("says out loud what it stopped short of, because nobody was there to ask", async () => {
    runAgentTurn.mockResolvedValue({
      text: "Forty orders.",
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
      steps: [],
      finishReason: "stop",
      paused: { reason: "confirmation", messages: [], summary: "Email the team?" },
    });
    const out = await runRoutineWithTools(env, db)(input, env);
    expect(out?.text).toContain("Forty orders.");
    expect(out?.text).toContain("Email the team?");
    expect(out?.text).toContain("nobody to ask");
  });
});
