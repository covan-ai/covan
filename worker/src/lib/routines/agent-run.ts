import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { complete, totalTokens, type CompletionMessage } from "../completion";
import { weighTokens } from "../entitlements";
import { resolveModel } from "../models";
import { temperatureFor, reasoningEffortFor } from "../prompt";
import { capabilitiesFor } from "../harness/available";
import { runAgentTurn } from "../harness/loop";
import { SCHEDULED_MAX_STEPS } from "../harness/budget";
import type { ToolEnv } from "../harness/registry";
import { DECISION_INSTRUCTION, readDecision } from "./summarise";
import type { AgentRunInput, AgentRunResult } from "./executor";

/**
 * A scheduled run that can use the same tools a chat turn can.
 *
 * The alternative was a second execution path, and it is worth saying why it
 * was not taken: a job set up in a conversation and then run on a schedule
 * would behave differently in the two places, and the difference would show up
 * as "it worked when I asked it and not overnight" — which nobody can debug.
 * So a routine with tools goes through `runAgentTurn`, exactly as chat does.
 *
 * The cost is a real dependency: a change to the loop changes what happens at
 * 3am. That is accepted and is the point.
 *
 * **Nobody is watching.** So a tool that returns `needs_confirmation` does not
 * wait — `runAgentTurn` returns paused, the run finishes with what it has, and
 * the record says the agent wanted to do something. That is 0058's own
 * argument: a tick has nowhere to wait, and a claim goes stale in thirty
 * minutes.
 */

/**
 * Whether this run has any tools at all, and the answer that means "no".
 *
 * `null` rather than a flag, because the caller's fallback is a different
 * function rather than a different argument: no tools means
 * `summariseWithModel`, which is the one-call path every routine used before
 * this existed and is strictly cheaper.
 */
/**
 * @param hasConnections whether this workspace has any connected service at
 * all, answered once per tick by the dispatcher rather than once per run.
 *
 * It is a parameter rather than a lookup for one reason, and it is not
 * elegance: on the cron Worker every database read is a subrequest, and
 * Workers Free allows fifty per invocation. A tick runs several routines, so
 * a per-run lookup is several subrequests spent discovering that the answer
 * is "no" — which it is for every deployment that has connected nothing.
 * `lib/routines/dispatcher.ts` does the arithmetic.
 *
 * Undefined means "ask" — which is what the single-routine paths (the Run now
 * button, a poked routine) do, because one run has no tick to amortise
 * anything over.
 */
export function runRoutineWithTools(
  env: RoutineEnv,
  db: SupabaseClient,
  hasConnections?: (workspaceId: string) => boolean,
) {
  return async (input: AgentRunInput, runEnv: RoutineEnv): Promise<AgentRunResult | null> => {
    // The free half of the question, when somebody has already answered it.
    if (hasConnections && !hasConnections(input.workspaceId)) return null;

    const toolEnv = runEnv as ToolEnv;
    const { tools, manifest } = await capabilitiesFor({
      db,
      env: toolEnv,
      workspaceId: input.workspaceId,
      userId: input.userId,
      surface: "schedule",
    });
    if (tools.length === 0) return null;

    const model = resolveModel(input.model, runEnv);
    const body = input.payloadText
      ? `Incoming webhook payload:\n\n${input.payloadText.slice(0, 20_000)}`
      : input.pageText
        ? `Watched page content:\n\n${input.pageText.slice(0, 20_000)}`
        : input.items
            .map((i) => `- ${i.title}\n  ${i.link}\n  ${i.summary.slice(0, 1_000)}`)
            .join("\n\n");

    const messages: CompletionMessage[] = [
      {
        role: "system",
        content: [
          input.persona,
          "You are running a scheduled routine for this team. Nobody is watching this run, " +
            "so anything that needs a person's approval will not happen — do the work you " +
            "can do and report what you could not.",
          manifest,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...(input.ragBlock ? [{ role: "system" as const, content: input.ragBlock }] : []),
      // The material rides in the user message with the instruction, for the
      // reason `summarise.ts` gives at length: a webhook payload is text
      // somebody outside this workspace chose, and a system message is the
      // wrong place for anything a stranger wrote.
      {
        role: "user" as const,
        content: body ? `${input.instruction}\n\n${body}` : input.instruction,
      },
    ];

    const turn = await runAgentTurn({
      env: runEnv,
      request: {
        model,
        messages,
        temperature: temperatureFor("normal", input.temperature),
        reasoningEffort: reasoningEffortFor(input.reasoningEffort),
        // Nobody is watching a scheduled run, so a readable account of the
        // model's reasoning is output tokens spent on a paragraph with no
        // reader. See `showThinking` in `lib/completion.ts`.
      },
      tools,
      // The one place the two surfaces are allowed to differ, and it is a
      // number rather than a capability: a scheduled run gets the smaller step
      // budget. `lib/harness/budget.ts` argues it — the cron Worker counts
      // subrequests against a ceiling of fifty, and nobody is watching a run
      // that spends four times the tokens to finish something it could have
      // reported as unfinished.
      budget: { maxSteps: SCHEDULED_MAX_STEPS },
      ctx: {
        db,
        env: toolEnv,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        userId: input.userId,
        routineRunId: input.routineRunId,
        // A scheduled run loops the same way a conversation does, so it can
        // repeat a search the same way. On the cron Worker the saving is a
        // subrequest, which is the budget that actually binds there.
        searchMemo: new Map<string, string>(),
        offeredSlugs: new Set<string>(),
      },
    });

    let tokens = totalTokens(turn.usage);
    // The same spend in the unit the allowance is denominated in. Kept beside
    // the raw figure rather than replacing it: `routine_runs.tokens` is the
    // durable record of how many tokens moved, which is what the run history
    // shows, and only the counter cares what they cost. See `weighTokens`.
    let weightedTokens = weighTokens(turn.usage);
    let text = turn.text;
    let declined = false;

    // The decision, as a turn of its own.
    //
    // `summariseWithModel` gets this free by asking for JSON in the same call.
    // That does not work here: a request that demands a single JSON object and
    // also offers tools puts the model in two minds, and what comes back is
    // either a tool call wrapped in JSON or a JSON object that never looked
    // anything up. So the work happens first, in prose, and the question of
    // whether it is worth sending is asked afterwards about the answer — one
    // extra short call on runs that are allowed to stay quiet.
    if (input.mayDecline && text.trim()) {
      const decision = await complete(runEnv, {
        model,
        json: true,
        reasoningEffort: "minimal",
        messages: [
          { role: "system", content: DECISION_INSTRUCTION },
          {
            role: "user",
            content: `Instruction: ${input.instruction}\n\nThe report you wrote:\n\n${text}`,
          },
        ],
      });
      tokens += totalTokens(decision.usage);
      weightedTokens += weighTokens(decision.usage);
      const read = readDecision(decision.text);
      text = read.text;
      declined = read.declined;
    }

    // What the agent wanted to do and could not, said out loud rather than
    // dropped. A run that quietly does three quarters of the job is the worst
    // of the three outcomes — worse than failing, because nothing says so.
    if (turn.paused?.reason === "confirmation" && !declined) {
      text =
        `${text}\n\n---\n\n_This run stopped short of "${turn.paused.summary ?? "an action"}" ` +
        `because it needs somebody to approve it, and a scheduled run has nobody to ask._`;
    }

    return { text, tokens, weightedTokens, declined };
  };
}
