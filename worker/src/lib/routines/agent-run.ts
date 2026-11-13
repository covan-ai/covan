import type { SupabaseClient } from "@supabase/supabase-js";
import { routineMaterial } from "./material";
import type { RoutineEnv } from "../../types";
import { complete, totalTokens, type CompletionMessage } from "../completion";
import { completionSpend, entitlementsFor, spends } from "../entitlements";
import { resolveModel } from "../models";
import { temperatureFor, reasoningEffortFor, maxTokensFor, whenAndWhere } from "../prompt";
import { capabilitiesFor } from "../harness/available";
import { runAgentTurn, type AgentTurnOptions, type PassUsage } from "../harness/loop";
import { routineBudget } from "../harness/budget";
import type { RoutineBrowser, ToolEnv } from "../harness/registry";
import { DECISION_INSTRUCTION, readDecision, REPLY_IS_THE_REPORT } from "./summarise";
import { addCounts, replyOutcome, sumOverPasses } from "../harness/usage";
import type { AgentRunInput, AgentRunResult } from "./executor";

/**
 * `browse` as a routine run meets it.
 *
 * The tool's own description is written for a conversation: the answer comes
 * back "as a new message", the browser opens "beside the conversation", and
 * the model is told to "say that you have started it". A run has no
 * conversation, and its reply has to be the result. Handed both, gpt-4.1 on
 * covan.app did the saying and called nothing — every run allowed the
 * browser, from 2026-10-24 to 2026-11-13, reported "I am opening the page…",
 * and some went on to state what the page said.
 */
const ROUTINE_BROWSE_DESCRIPTION =
  "Do something on a web page: read a page that needs JavaScript, pull a number out of a " +
  "site with no API, follow a few links. You give ONE instruction in plain language and a " +
  "real browser carries it out. In this run its answer does not come back to you: it is " +
  "written into this run's report when the browser finishes, a few minutes after your reply. " +
  "So you do not know what a page says unless this tool fetched it — call it for each thing " +
  "the instruction needs from a web page, then write the rest of the report and leave the " +
  "page's answer to it. When the task has to sign in to a site, put that site's host in " +
  "`site`. When the instruction wants something done with the answer once it arrives, put " +
  "that next step in `then`. Use http_request instead when the thing you want has an API.";

/**
 * What a run allowed the browser is told when it called no tool at all. A
 * `user` turn, and it says who is speaking: the routine's owner did not write
 * it, and a model that took it for theirs would answer them.
 */
const NOTHING_WAS_OPENED =
  "Covan here, not the routine's owner: you called no tool, so nothing was opened and nothing " +
  "will be added to your report. If the instruction needs anything from a web page, call the " +
  "`browse` tool for it now. If it needs nothing from a web page, reply with your report " +
  "again, unchanged.";

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
 * **Nobody is watching.** So a tool that returns `needs_confirmation` cannot
 * be answered in this tick — `runAgentTurn` returns paused, and the run hands
 * the question back as `asking`. The executor parks it for a day and asks the
 * routine's owner (0143, `lib/approvals/park.ts`); the cron carries on once
 * somebody answers. A tick still has nowhere to wait, which is why the
 * waiting is a row rather than this function.
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
    // A routine allowed the browser has a tool whatever it has connected.
    if (hasConnections && !hasConnections(input.workspaceId) && !input.browser) return null;

    const toolEnv = runEnv as ToolEnv;
    const { tools, manifest } = await capabilitiesFor({
      db,
      env: toolEnv,
      workspaceId: input.workspaceId,
      userId: input.userId,
      surface: "schedule",
      browser: Boolean(input.browser),
      agentId: input.agentId,
    });
    if (tools.length === 0) return null;

    // What `browse` reads in place of an approval card, and where it writes
    // down the tasks the report has to wait for. See `lib/routines/held.ts`.
    const routineBrowser: RoutineBrowser | undefined =
      input.browser && tools.some((t) => t.name === "browse")
        ? { ...input.browser, started: [] }
        : undefined;
    const offered = routineBrowser
      ? tools.map((t) =>
          t.name === "browse" ? { ...t, description: ROUTINE_BROWSE_DESCRIPTION } : t,
        )
      : tools;

    const model = resolveModel(input.model, runEnv);
    const body = routineMaterial(input);

    const messages: CompletionMessage[] = [
      {
        role: "system",
        content: [
          input.persona,
          "You are running a scheduled routine for this team. Nobody is watching this run. " +
            "When a change needs a person's approval, ask for it the way you would in a " +
            "conversation: the routine's owner is asked, and this run waits for their answer " +
            "and carries on once they give it. So do everything that needs no approval first, " +
            "and ask last.",
          REPLY_IS_THE_REPORT,
          // This path is the reason #192 happened. It has tools, so it writes
          // into other people's calendars and trackers, and it is the one
          // surface with nobody to notice a date landing wrong — and until now
          // it was the only tool-running path never told the date or the zone.
          // `routines.timezone` is the schedule's own zone, so "every Monday at
          // 22:00" means the same thing to the cron and to the model.
          whenAndWhere(new Date(), input.timezone),
          // "Start the tasks" alone was read as "say that you started them":
          // on covan.app runs allowed the browser wrote "I am opening the
          // page…" and called nothing, so the report waited on no task and
          // once carried a time the model made up. Saying it is not doing it.
          routineBrowser
            ? "This routine's owner allows it to use the browser. For each thing the " +
              "instruction needs from a web page, call the `browse` tool — writing that you are " +
              "opening a page does not open it, and only a `browse` call does. Never write a " +
              "page's contents you have not been given. A browser task's answer is written " +
              "into this report when it arrives, so once you have called `browse`, write the " +
              "rest of the report around it." +
              (routineBrowser.ask
                ? " The owner has to approve each browser task before it starts; call " +
                  "`browse` anyway, and this run waits for their answer."
                : "")
            : null,
          manifest,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      // `user`, for the same reason the webhook payload below is: a document
      // body arrives here through Notion, Drive or Slack sync, so it is also
      // text somebody outside this workspace chose. Until the 2026-10-08 audit
      // this line said `system` — four lines above the comment stating the
      // opposite rule.
      ...(input.ragBlock
        ? [{ role: "user" as const, content: input.ragBlock, volatile: true as const }]
        : []),
      // The material rides in the user message with the instruction, for the
      // reason `summarise.ts` gives at length: a webhook payload is text
      // somebody outside this workspace chose, and a system message is the
      // wrong place for anything a stranger wrote.
      {
        role: "user" as const,
        content: body ? `${input.instruction}\n\n${body}` : input.instruction,
      },
    ];

    // The run's spend so far, held against its workspace before each step
    // (`Entitlements.hold`), so a run that began on the last credit stops when
    // the credit does rather than eight passes later. The executor checked once
    // before it started; this is every check after that.
    const entitlements = entitlementsFor(runEnv);
    const holdId = crypto.randomUUID();
    const passesSoFar: PassUsage[] = [];
    const spentSoFar = () =>
      spends(
        completionSpend(
          model,
          {
            promptTokens: sumOverPasses(passesSoFar, (p) => p.prompt),
            completionTokens: sumOverPasses(passesSoFar, (p) => p.completion),
            cachedTokens: sumOverPasses(passesSoFar, (p) => p.cached),
            cacheWriteTokens: sumOverPasses(passesSoFar, (p) => p.written),
            reasoningTokens: sumOverPasses(passesSoFar, (p) => p.reasoning),
            webSearches: sumOverPasses(passesSoFar, (p) => p.searches),
          },
          "routine",
        ),
      );

    const turnOptions: AgentTurnOptions = {
      env: runEnv,
      onPass: (usage) => passesSoFar.push(usage),
      ...(entitlements.hold
        ? {
            mayContinue: () => entitlements.hold!(input.workspaceId, holdId, spentSoFar()),
          }
        : {}),
      request: {
        model,
        messages,
        temperature: temperatureFor("normal", input.temperature),
        reasoningEffort: reasoningEffortFor(input.reasoningEffort),
        // The same ceiling the chat route sends, and stated rather than left
        // out. Omitted, Anthropic falls back to `DEFAULT_MAX_TOKENS` — the same
        // 4,096 — but OpenAI sends no `max_completion_tokens` field at all, so
        // the one surface with nobody watching it was the one with no output
        // ceiling. `maxTurnTokens` would still have stopped a runaway, but only
        // after the tokens were bought.
        maxTokens: maxTokensFor("normal"),
        // The agent's switch, as `routes/chat.ts` sends it. Its searches are
        // already counted in the run's usage (`webSearches` above).
        webSearch: input.webSearch === true,
        // Nobody is watching a scheduled run, so a readable account of the
        // model's reasoning is output tokens spent on a paragraph with no
        // reader. See `showThinking` in `lib/completion.ts`.
      },
      tools: offered,
      // The one place the two surfaces are allowed to differ, and it is a
      // number rather than a capability: a scheduled run gets the smaller step
      // budget. `lib/harness/budget.ts` argues it — the cron Worker counts
      // subrequests against a ceiling of fifty, and nobody is watching a run
      // that spends four times the tokens to finish something it could have
      // reported as unfinished. That is Free's argument; on Paid, where the
      // fifty is ten thousand, `routineBudget` gives a run more (`limits.ts`).
      budget: routineBudget(runEnv),
      ctx: {
        db,
        env: toolEnv,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        userId: input.userId,
        routineRunId: input.routineRunId,
        ...(input.chainDepth ? { chainDepth: input.chainDepth } : {}),
        // Shared knowledge only unless the run says whose it is.
        knowledgeScope: input.knowledgeScope ?? { sharedOnly: true },
        ...(routineBrowser ? { routineBrowser } : {}),
        // A scheduled run loops the same way a conversation does, so it can
        // repeat a search the same way. On the cron Worker the saving is a
        // subrequest, which is the budget that actually binds there.
        searchMemo: new Map<string, string>(),
        // And schemas already described, for the same reason.
        describeMemo: new Map<string, string>(),
        offeredSlugs: new Set<string>(),
        offeredOperations: new Map(),
        // And no `priorSearches`, which is not an omission that can be fixed
        // here: the cross-turn seeding reads this conversation's own
        // `message_steps` (see `lib/harness/offerings.ts`), and a scheduled run
        // has no session and writes no steps at all. So a routine that runs the
        // same search every morning pays for it every morning, and `run_tool`'s
        // guard stands down on every run. Both halves of covan#216 and #214
        // stop at the same place, and closing it means deciding what a run
        // should be allowed to remember of the last one — a product question,
        // not a missing read.
      },
    };
    let turn = await runAgentTurn(turnOptions);

    // Once, and only for a run allowed the browser that touched no tool at
    // all. Neither the prompt nor `browse`'s own description was enough:
    // gpt-4.1 on covan.app, told both, still called it on one run in three and
    // wrote "I am opening the page…" on the others. Told afterwards that
    // nothing was opened, it called it — and with a task that needed no page,
    // it said its answer again. The extra pass reads the cached prefix, and a
    // run that does use a tool never pays it.
    const calledNothing =
      turn.steps.length === 0 && routineBrowser?.started.length === 0 && !turn.paused;
    if (routineBrowser && calledNothing && turn.text.trim()) {
      const again = await runAgentTurn({
        ...turnOptions,
        request: {
          ...turnOptions.request,
          messages: [
            ...messages,
            { role: "assistant", content: turn.text },
            { role: "user", content: NOTHING_WAS_OPENED },
          ],
        },
      });
      turn = {
        ...again,
        usage: addCounts(turn.usage, again.usage),
        passes: [...turn.passes, ...again.passes],
      };
    }

    // The executor records this run's charge as soon as it returns; until then
    // the hold lapses on its own if this is never reached.
    await entitlements.release?.(holdId).catch((err: unknown) => {
      console.error("could not release a routine run's credit hold", err);
    });

    let tokens = totalTokens(turn.usage);
    // What was consumed, for the ledger. Kept beside the raw figure rather
    // than replacing it: `routine_runs.tokens` is the durable record of how
    // many tokens moved, which is what the run history shows.
    const spend = spends(completionSpend(model, turn.usage, "routine"));
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
    //
    // Not asked of a report that is waiting on its browser: the draft has a
    // gap where the answer goes, and "nothing worth sending" cannot be judged
    // of a report that is not finished yet.
    //
    // Nor of a run that did not get to do all of it: a turn that stopped at a
    // ceiling or for a question, or one in which a tool call failed. Its report
    // is written to say what did not happen, which is exactly what the decision
    // is told to call irrelevant — and on 2026-10-26 it did, for an event
    // routine that spent its whole step budget, so the history said "nothing
    // matched" and its owner heard nothing. `readDecision`'s rule, applied one
    // step earlier: when anything went wrong, send.
    const heldFor = routineBrowser?.started ?? [];
    const incomplete =
      turn.paused !== undefined ||
      turn.steps.some((s) => s.status === "failed" || s.status === "refused");
    if (input.mayDecline && text.trim() && heldFor.length === 0 && !incomplete) {
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
      spend.push(...spends(completionSpend(model, decision.usage, "routine")));
      const read = readDecision(decision.text);
      text = read.text;
      declined = read.declined;
    }

    // What the agent is asking, handed to the executor to park (0143). The
    // text is the report so far; where the run cannot be parked the executor
    // adds `stoppedShortNote`, so the question is said out loud either way —
    // a run that quietly does three quarters of the job is the worst of the
    // outcomes, because nothing says so.
    const asking =
      turn.paused?.reason === "confirmation" && turn.paused.call
        ? { paused: turn.paused, steps: turn.steps }
        : undefined;

    return {
      text,
      tokens,
      spend,
      declined,
      ...(heldFor.length > 0 ? { heldFor } : {}),
      ...(asking ? { asking } : {}),
      // What the row will say about the call, through the same `replyOutcome`
      // the chat path uses rather than a second mapping. `parked: false` is a
      // constant here because this function cannot know whether the executor
      // will manage to park the question (`asking`), and `paused` on a row
      // nobody was asked about would claim forever to be waiting on somebody.
      // A run that did park says so in its own status, `waiting`.
      //
      // `said` is read off `turn.text` rather than the `text` above, which by
      // this point may carry the appended note about what the run stopped short
      // of. `empty` is about what the model produced, not about what was written
      // around it.
      model,
      modelOutcome: replyOutcome({
        paused: turn.paused ?? null,
        finishReason: turn.finishReason,
        parked: false,
        said: turn.text.trim().length > 0,
      }),
    };
  };
}
