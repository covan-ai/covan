import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { agentAccessFor } from "../agent-access";
import { nudge } from "../browser/deliver";
import { browserTaskNote } from "../browser/task-note";
import type { CompletionMessage } from "../completion";
import { completionSpend, entitlementsFor, spends, type Entitlements } from "../entitlements";
import { capabilitiesFor } from "../harness/available";
import { SCHEDULED_MAX_STEPS } from "../harness/budget";
import { runAgentTurn, type PassUsage } from "../harness/loop";
import type { RoutineBrowser, ToolContext, ToolEnv } from "../harness/registry";
import { writeSteps } from "../harness/turn";
import { replyOutcome, sumOverPasses, usageColumns } from "../harness/usage";
import { attributeSenders, MSG_HISTORY_LIMIT, selectHistory } from "../history";
import { resolveModel } from "../models";
import {
  DEFAULT_PERSONA,
  maxTokensFor,
  reasoningEffortFor,
  temperatureFor,
  whenAndWhere,
} from "../prompt";
import { completeHeldRun } from "../routines/held";
import { REPLY_IS_THE_REPORT } from "../routines/summarise";
import { serviceClient } from "../supabase";

/**
 * The woken turn (0142): an agent turn in an existing conversation, run from
 * the cron, with tools, with nobody watching.
 *
 * **A new turn, not a resumed one.** 0117 said why the cron cannot pick a
 * chat turn back up: a turn replays its caller's own request
 * (`lib/turns/detached.ts`), and the cron has no caller. What the cron does
 * have is the pattern scheduled routines already run on — `runAgentTurn`
 * with the service role and the owner as the caller (`lib/routines/agent-run.ts`)
 * — so that is what this is, pointed at a conversation instead of a report.
 * The conversation is read fresh, the wake-up is the last user turn, and the
 * reply is one assistant message there, so a person reading it later sees
 * the agent speak at 14:35 about what it found.
 *
 * **Why the service role, and what bounds it.** A tick has no JWT for RLS to
 * resolve. Everything here is keyed to the one row the claim handed over,
 * whose ids an authenticated turn wrote (`rows.ts`, `browse.ts`); the
 * conversation is checked to still belong to that person before anything is
 * read; and the writes are one message, its steps, and the spend on that
 * workspace. `service-client.static.test.ts` pins this file for that reason.
 *
 * **What a woken turn may do** is decided by the tools, not here: `browse`
 * runs without a card only where one was approved in this conversation before
 * (`continuation.browserApproved`), a connected app's change goes through on
 * a standing permission or errors, and the tools a scheduled run is not
 * offered (`capabilitiesFor`, surface `schedule`) are not offered here either.
 *
 * **Two kinds of wake-up, one runner.** A timer (`continue_later`) wakes with
 * the agent's own note; the step after a browser task (0117's `then_step`,
 * claimed by the cron when no tab did) wakes with the words the tab would have
 * sent. A routine's wake-up runs in the routine's own conversation with the
 * held run's id, so its browser tasks attach to the run and its reply is the
 * report (`completeHeldRun`'s `report`).
 */

/** What the tab sends when it carries on (`routes/_authed.agents.$agentId.chat.tsx`). */
export const CARRY_ON = "The browser is done — carry on with the next step.";

/** A row that says a turn ran and said nothing, rather than an empty message. */
export const NOTHING_SAID = "(came back to this and had nothing to add)";

const UNWATCHED =
  "You are carrying on something you put down earlier in this conversation. Nobody is " +
  "watching now: do what you can without asking, say plainly what you could not do, and if " +
  "it is still not time, call continue_later again rather than waiting. If the person has " +
  "since asked you to stop or changed what they want, do that instead.";

export type WakeUp = {
  /** The continuation's id, or `task:<id>` for the step after a browser task. */
  id: string;
  kind: "timer" | "after_browser";
  workspaceId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  routineRunId: string | null;
  /** The agent's note, or the step after the browser — what a task the turn starts carries on with. */
  note: string;
};

export type RunDeps = {
  db: SupabaseClient;
  now: () => Date;
  turn: typeof runAgentTurn;
  capabilities: typeof capabilitiesFor;
  entitlements: Entitlements;
};

export type Woken = { status: "done" | "failed"; error?: string; text?: string };

function resolve(env: RoutineEnv, overrides: Partial<RunDeps>): RunDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    turn: overrides.turn ?? runAgentTurn,
    capabilities: overrides.capabilities ?? capabilitiesFor,
    entitlements: overrides.entitlements ?? entitlementsFor(env),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

type SessionRow = {
  id: string;
  user_id: string;
  visibility: string | null;
  deleted_at: string | null;
};

type AgentRow = {
  persona: string | null;
  model: string | null;
  temperature: number | null;
  reasoning_effort: string | null;
};

type RoutineSide = {
  runId: string;
  browser: Omit<RoutineBrowser, "started" | "conversation"> | null;
  timezone: string | null;
};

const MAX_THEN_CHARS = 1000;

export async function runContinuationTurn(
  env: RoutineEnv,
  wake: WakeUp,
  overrides: Partial<RunDeps> = {},
): Promise<Woken> {
  const deps = resolve(env, overrides);
  const { db } = deps;
  const startedAt = deps.now();
  try {
    // 1. The conversation, and that it is still this person's.
    const { data: sessionData, error: sessionError } = await db
      .from("chat_sessions")
      .select("id, user_id, visibility, deleted_at")
      .eq("id", wake.sessionId)
      .maybeSingle();
    if (sessionError) return failed(wake, `could not read the conversation: ${sessionError.code}`);
    const session = sessionData as SessionRow | null;
    if (!session || session.deleted_at || session.user_id !== wake.userId) {
      return failed(wake, "conversation is gone");
    }

    // 1b. That the person is still a member, and may still use the agent —
    // the executor's two checks (`lib/routines/executor.ts`), for its reason:
    // removing somebody cuts their RLS access instantly, but this runs under
    // the service role, and a wake-up can be twelve hours old.
    const { data: membership, error: membershipError } = await db
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", wake.workspaceId)
      .eq("user_id", wake.userId)
      .maybeSingle();
    if (membershipError) {
      return failed(wake, `could not read the membership: ${membershipError.code}`);
    }
    if (!membership) return failed(wake, "the person is no longer a member of this workspace");
    const access = await agentAccessFor(db, wake.agentId, wake.userId);
    if (!access) return failed(wake, "the person can no longer use this agent");

    // 2. The agent.
    const { data: agentData, error: agentError } = await db
      .from("agents")
      .select("persona, model, temperature, reasoning_effort")
      .eq("id", wake.agentId)
      .eq("workspace_id", wake.workspaceId)
      .maybeSingle();
    if (agentError) return failed(wake, `could not read the agent: ${agentError.code}`);
    const agent = agentData as AgentRow | null;
    if (!agent) return failed(wake, "agent is gone");

    // 3. The held run, for a routine's wake-up.
    let routine: RoutineSide | null = null;
    if (wake.routineRunId) {
      const side = await routineSide(db, wake.routineRunId);
      if (side.kind === "error") return failed(wake, side.message);
      routine = side.value;
    }

    // 4. Credits, before the model. A routine's report still goes out.
    // A timer's own row is still `running` until the dispatcher settles it,
    // so the held report is told not to wait on it (`chainPending`'s
    // `except`); a step after the browser has no row of its own.
    const except = wake.kind === "timer" ? { except: wake.id } : {};
    const verdict = await deps.entitlements.check(wake.workspaceId);
    if (!verdict.allowed) {
      if (routine) await completeHeldRun(env, routine.runId, { db }, except);
      return failed(wake, "the workspace has no credits to wake with");
    }

    // 5. Whether a browser was ever approved in this conversation, by this person.
    const browserApproved = routine ? false : await browserApprovedIn(db, wake);
    const browserOn = routine ? routine.browser !== null : browserApproved;

    // 6. The tools, as a scheduled run gets them.
    const toolEnv = env as ToolEnv;
    const { tools, manifest } = await deps.capabilities({
      db,
      env: toolEnv,
      workspaceId: wake.workspaceId,
      userId: wake.userId,
      surface: "schedule",
      browser: browserOn,
      agentId: wake.agentId,
    });

    // 7. The conversation so far, and where its browser tasks stand.
    const history = await historyOf(db, wake.sessionId);
    const taskNote = tools.some((t) => t.name === "browse")
      ? await browserTaskNote(db, wake.sessionId, deps.now())
      : null;

    const model = resolveModel(agent.model, env);
    const messages: CompletionMessage[] = [
      {
        role: "system",
        content: [
          agent.persona?.trim() || DEFAULT_PERSONA,
          UNWATCHED,
          routine ? REPLY_IS_THE_REPORT : null,
          whenAndWhere(deps.now(), routine?.timezone ?? null),
          manifest,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...history,
      ...(taskNote
        ? [{ role: "system" as const, content: taskNote, volatile: true as const }]
        : []),
      {
        role: "user",
        content:
          wake.kind === "timer"
            ? `You asked to be woken now. Your note to yourself: "${wake.note}"`
            : CARRY_ON,
      },
    ];

    // 8. The turn, held against the workspace per step as a routine's is.
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
          routine ? "routine" : "reply",
        ),
      );
    const routineBrowser: RoutineBrowser | undefined = routine?.browser
      ? { ...routine.browser, conversation: async () => wake.sessionId, started: [] }
      : undefined;
    const ctx: ToolContext = {
      db,
      env: toolEnv,
      workspaceId: wake.workspaceId,
      agentId: wake.agentId,
      userId: wake.userId,
      sessionId: wake.sessionId,
      continuation: { id: wake.id, browserApproved },
      // The owner's own knowledge in a private conversation, shared only
      // where others can read the reply — the chat route's rule (0106).
      knowledgeScope:
        session.visibility === "private" ? { viewer: wake.userId } : { sharedOnly: true },
      searchMemo: new Map<string, string>(),
      describeMemo: new Map<string, string>(),
      offeredSlugs: new Set<string>(),
      offeredOperations: new Map(),
      ...(routine ? { routineRunId: routine.runId } : {}),
      ...(routineBrowser ? { routineBrowser } : {}),
    };
    const hold = deps.entitlements.hold?.bind(deps.entitlements);
    const turn = await deps.turn({
      env,
      onPass: (usage) => passesSoFar.push(usage),
      ...(hold ? { mayContinue: () => hold(wake.workspaceId, holdId, spentSoFar()) } : {}),
      request: {
        model,
        messages,
        temperature: temperatureFor("normal", agent.temperature),
        reasoningEffort: reasoningEffortFor(agent.reasoning_effort),
        maxTokens: maxTokensFor("normal"),
      },
      tools,
      budget: { maxSteps: SCHEDULED_MAX_STEPS },
      ctx,
    });
    await deps.entitlements.release?.(holdId).catch((err: unknown) => {
      console.error("could not release a woken turn's credit hold", err);
    });

    // 9. The reply, with what it stopped short of said out loud.
    const said = turn.text.trim();
    let content = said;
    if (turn.paused?.reason === "confirmation") {
      content =
        `${content}\n\n---\n\n_This stopped short of "${turn.paused.summary ?? "an action"}" ` +
        "because it needs somebody to approve it, and nobody was watching._";
    }
    content = content.trim() || NOTHING_SAID;
    const usage = { ...turn.usage, passes: turn.passes };

    const { data: message, error: messageError } = await db
      .from("messages")
      .insert({
        session_id: wake.sessionId,
        role: "assistant",
        content,
        sender_id: null,
        model,
        outcome: replyOutcome({
          paused: turn.paused ?? null,
          finishReason: turn.finishReason,
          parked: false,
          said: said.length > 0,
        }),
        ...usageColumns(usage),
      })
      .select("id")
      .single();
    if (messageError || !message) {
      return failed(wake, `could not write the reply: ${messageError?.code ?? "no row"}`);
    }
    const messageId = String(message.id);
    await writeSteps(db, messageId, turn.steps);
    await db
      .from("chat_sessions")
      .update({ updated_at: deps.now().toISOString() })
      .eq("id", wake.sessionId);

    const charge = spends(completionSpend(model, turn.usage, routine ? "routine" : "reply"));
    if (charge.length > 0) {
      try {
        await deps.entitlements.record(wake.workspaceId, charge, {
          userId: wake.userId,
          sessionId: wake.sessionId,
          messageId,
        });
      } catch (err) {
        console.error("could not charge for a woken turn", wake.id, err);
      }
    }

    // 10. A task this turn started without saying what comes next carries
    // the note on, so a chain that forgot does not die at the next answer.
    const since = startedAt.toISOString();
    await db
      .from("browser_tasks")
      .update({ then_step: `Carry on with: ${wake.note}`.slice(0, MAX_THEN_CHARS) })
      .eq("session_id", wake.sessionId)
      .gte("created_at", since)
      .is("then_step", null);

    if (routine) {
      await completeHeldRun(env, routine.runId, { db }, { report: content, ...except });
    } else if (await chainEnded(db, wake.sessionId, since)) {
      await nudge(
        env,
        db,
        wake.userId,
        { subject: "Your agent came back to this", body: content },
        wake.id,
      );
    }
    return { status: "done", text: content };
  } catch (err) {
    console.error("a woken turn failed", wake.id, err);
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

function failed(wake: WakeUp, error: string): Woken {
  console.warn("a wake-up could not run", wake.id, error);
  return { status: "failed", error };
}

async function routineSide(
  db: SupabaseClient,
  runId: string,
): Promise<{ kind: "ok"; value: RoutineSide } | { kind: "error"; message: string }> {
  const { data: run, error: runError } = await db
    .from("routine_runs")
    .select("id, routine_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runError) return { kind: "error", message: `could not read the run: ${runError.code}` };
  if (!run) return { kind: "error", message: "routine run is gone" };
  if (run.status !== "waiting")
    return { kind: "error", message: "routine run is no longer waiting" };

  const { data: routine, error: routineError } = await db
    .from("routines")
    .select("browser_access, browser_site, timezone")
    .eq("id", String(run.routine_id))
    .maybeSingle();
  if (routineError) {
    return { kind: "error", message: `could not read the routine: ${routineError.code}` };
  }
  if (!routine) return { kind: "error", message: "routine is gone" };

  const access = text(routine.browser_access);
  const site = text(routine.browser_site);
  const browser: RoutineSide["browser"] =
    access === "all" ? { access, site: null } : access === "site" && site ? { access, site } : null;
  return { kind: "ok", value: { runId, browser, timezone: text(routine.timezone) } };
}

/** A browser task of this person's in this conversation: a card said yes here once. */
async function browserApprovedIn(db: SupabaseClient, wake: WakeUp): Promise<boolean> {
  const { data, error } = await db
    .from("browser_tasks")
    .select("id")
    .eq("session_id", wake.sessionId)
    .eq("user_id", wake.userId)
    .limit(1);
  if (error) {
    console.warn("could not read a conversation's browser tasks", wake.sessionId, error.code);
    return false;
  }
  return (data ?? []).length > 0;
}

async function historyOf(db: SupabaseClient, sessionId: string): Promise<CompletionMessage[]> {
  const { data, error } = await db
    .from("messages")
    .select("role, content, sender_id")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(MSG_HISTORY_LIMIT);
  if (error) {
    console.warn("could not read a conversation for its wake-up", sessionId, error.code);
    return [];
  }
  const rows = ((data ?? []) as Array<{ role: unknown; content: unknown; sender_id: unknown }>)
    .filter((r) => (r.role === "user" || r.role === "assistant") && typeof r.content === "string")
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content as string,
      sender_id: typeof r.sender_id === "string" ? r.sender_id : null,
    }))
    .reverse();
  return selectHistory(attributeSenders(rows, new Map(), false));
}

/** Nothing started and nothing set since the turn began: the chain is over. */
async function chainEnded(db: SupabaseClient, sessionId: string, since: string): Promise<boolean> {
  const { data: tasks } = await db
    .from("browser_tasks")
    .select("id")
    .eq("session_id", sessionId)
    .gte("created_at", since)
    .limit(1);
  if ((tasks ?? []).length > 0) return false;
  const { data: waits } = await db
    .from("continuations")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .gte("created_at", since)
    .limit(1);
  return (waits ?? []).length === 0;
}
