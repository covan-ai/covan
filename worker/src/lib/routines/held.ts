import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { canFileDocuments } from "../../types";
import { complete, totalTokens, type CompletionUsage } from "../completion";
import {
  completionSpend,
  embeddingSpend,
  entitlementsFor,
  spends,
  type Spend,
} from "../entitlements";
import { embeddingModel } from "../embeddings";
import { resolveModel } from "../models";
import { serviceClient } from "../supabase";
import {
  CONFIRMABLE_COLUMNS,
  readyForDelivery,
  type ConfirmableChannel,
} from "./address-confirmation";
import { deliver, deliveryDepsFrom } from "./delivery";
import { fileRoutineOutput, NOTE_NO_DOCUMENT_STORE, NOTE_VIEWER } from "./filing";
import { EVENT_DELIVERED } from "./webhook";

/**
 * A routine's report, held while its browser finishes (0100).
 *
 * A routine whose owner allowed the browser can start a browser task in its
 * turn, and the answer to one arrives minutes after the turn has ended. The
 * engine used to deliver the moment the turn ended, so the report would have
 * gone out saying "a browser is checking this" and the answer would have gone
 * nowhere. Now the run is written as `waiting`, with its draft in `summary`,
 * and the report is sent once — here — when the last of its browser tasks has
 * answered, with the answers written into it.
 *
 * Three things call `completeHeldRun`, and any of them may be first:
 *
 *  - the executor, straight after it writes the waiting row, for a task that
 *    somehow answered before the row existed;
 *  - `deliverBrowserTask`, after it writes a task's answer into the routine's
 *    conversation — which every settle goes through, the open tab's and the
 *    cron's alike;
 *  - the sweep below, for a run whose tasks never answered at all.
 *
 * So the finish begins with a claim: a conditional update of
 * `held_claimed_at`, and only the caller that gets the row back sends. It is
 * `settleBrowserTask`'s discipline — a side effect that must happen once is
 * gated on a write that can succeed once.
 */

/**
 * How long a report waits for its browser before it is sent without it.
 *
 * The poller gives up on a task after `MAX_POLLS` five-minute ticks, so a task
 * that started is answered — with a failure if nothing else — in well under an
 * hour. What can wait longer is a task in line behind a sign-in the person has
 * not done (0080's login hold), or a line the sweep closed. Two hours is long
 * past the first and short enough that a daily report still arrives the same
 * morning.
 */
export const HELD_MAX_MS = 2 * 60 * 60 * 1000;

/** A claim older than this is a finish that died half way, and is taken again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** How many overdue runs one quiet tick finishes. Each is a model call and a delivery. */
const SWEEP_BATCH = 2;

/** Statuses a task can still answer from. `waiting` is a task in line (0080). */
const UNANSWERED = ["waiting", "queued", "running"];

/** A browser answer is written into the report at most this long. */
const ANSWER_CHARS = 6000;

export type HeldDeps = {
  db: SupabaseClient;
  now: () => Date;
  /** The one model call that writes the answers into the draft. */
  compose: typeof composeReport;
};

function resolve(env: RoutineEnv, overrides: Partial<HeldDeps>): HeldDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    compose: overrides.compose ?? composeReport,
  };
}

/**
 * The routine's conversation, opened if it has none.
 *
 * The owner's own, private, titled after the routine, so it reads in their
 * conversation list as what it is: the place this routine's browser works.
 * Through the service role — a tick has no caller — with every id read off
 * the routine row, never from a model. A conversation somebody deleted (soft,
 * 0040) is not reused; a new one is opened and the routine points at it.
 */
export async function openRoutineConversation(
  db: SupabaseClient,
  routine: {
    id: string;
    name: string;
    agent_id: string;
    user_id: string;
    workspace_id: string;
    browser_conversation_id?: string | null;
  },
): Promise<string | null> {
  try {
    if (routine.browser_conversation_id) {
      const { data: kept } = await db
        .from("chat_sessions")
        .select("id")
        .eq("id", routine.browser_conversation_id)
        .eq("user_id", routine.user_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (kept?.id) return String(kept.id);
    }

    const { data: opened, error } = await db
      .from("chat_sessions")
      .insert({
        agent_id: routine.agent_id,
        user_id: routine.user_id,
        workspace_id: routine.workspace_id,
        title: `Routine: ${routine.name}`,
        kind: "chat",
        visibility: "private",
      })
      .select("id")
      .single();
    if (error || !opened) {
      console.error("could not open a routine's browser conversation", error?.code);
      return null;
    }
    const id = String(opened.id);
    const { error: linkError } = await db
      .from("routines")
      .update({ browser_conversation_id: id })
      .eq("id", routine.id);
    if (linkError) {
      // The task can still run and answer into it; the next run opens another.
      console.error("could not remember a routine's browser conversation", linkError.code);
    }
    routine.browser_conversation_id = id;
    return id;
  } catch (err) {
    console.error("could not open a routine's browser conversation", err);
    return null;
  }
}

type HeldRun = {
  id: string;
  routine_id: string;
  started_at: string;
  tokens: number | null;
  summary: string | null;
  items_new?: number | null;
  items_overflow?: number | null;
};

type HeldRoutine = {
  id: string;
  name: string;
  agent_id: string;
  user_id: string;
  workspace_id: string;
  instruction: string;
  delivery_channel_id: string;
  output_bundle_id: string | null;
  output_retention: number | null;
  ends_after_runs: number | null;
  runs_done: number;
  status: string;
};

export type HeldTask = {
  id: string;
  task: string;
  status: string;
  output: string | null;
  error: string | null;
  retry_of: string | null;
};

/**
 * Send a waiting run's report, if every browser task it started has answered.
 *
 * Returns whether this call sent it. Never throws: it runs at the end of a
 * settle, whose own work is already done, and a report that could not be sent
 * now is sent by the sweep later.
 */
export async function completeHeldRun(
  env: RoutineEnv,
  runId: string,
  overrides: Partial<HeldDeps> = {},
  opts: { overdue?: boolean } = {},
): Promise<boolean> {
  const deps = resolve(env, overrides);
  try {
    const tasks = await tasksOf(deps.db, runId);
    if (tasks === null) return false;
    if (!opts.overdue && tasks.some((t) => UNANSWERED.includes(t.status))) return false;

    const run = await claim(deps, runId);
    if (!run) return false;
    await finishHeld(env, deps, run, tasks);
    return true;
  } catch (err) {
    console.error("could not finish a routine run that waited on its browser", runId, err);
    return false;
  }
}

/**
 * The runs that have waited longer than `HELD_MAX_MS`, sent with what they
 * have. One indexed read on every quiet tick, and nothing else unless there is
 * one — which is the cost the cron's other stages are held to.
 */
export async function sweepHeldRuns(
  env: RoutineEnv,
  overrides: Partial<HeldDeps> = {},
): Promise<{ finished: number }> {
  const deps = resolve(env, overrides);
  const cutoff = new Date(deps.now().getTime() - HELD_MAX_MS).toISOString();
  const { data, error } = await deps.db
    .from("routine_runs")
    .select("id")
    .eq("status", "waiting")
    .lt("started_at", cutoff)
    .order("started_at", { ascending: true })
    .limit(SWEEP_BATCH);
  if (error) {
    console.error("could not read the routine runs waiting on a browser", error.code);
    return { finished: 0 };
  }
  let finished = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    if (await completeHeldRun(env, String(row.id), overrides, { overdue: true })) finished += 1;
  }
  return { finished };
}

async function tasksOf(db: SupabaseClient, runId: string): Promise<HeldTask[] | null> {
  const { data, error } = await db
    .from("browser_tasks")
    .select("id, task, status, output, error, retry_of")
    .eq("routine_run_id", runId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("could not read a waiting routine run's browser tasks", runId, error.code);
    return null;
  }
  return (data ?? []) as HeldTask[];
}

/**
 * The claim: a waiting run nobody is finishing, or one whose finisher died.
 * Postgres serialises two such updates, so exactly one caller gets the row.
 */
async function claim(deps: HeldDeps, runId: string): Promise<HeldRun | null> {
  const now = deps.now();
  const stale = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const { data, error } = await deps.db
    .from("routine_runs")
    .update({ held_claimed_at: now.toISOString() })
    .eq("id", runId)
    .eq("status", "waiting")
    .or(`held_claimed_at.is.null,held_claimed_at.lt."${stale}"`)
    .select("id, routine_id, started_at, tokens, summary, items_new, items_overflow")
    .maybeSingle();
  if (error) {
    console.error("could not claim a waiting routine run", runId, error.code);
    return null;
  }
  return (data as HeldRun | null) ?? null;
}

async function finishHeld(
  env: RoutineEnv,
  deps: HeldDeps,
  run: HeldRun,
  tasks: HeldTask[],
): Promise<void> {
  const { data: routineRow, error: routineError } = await deps.db
    .from("routines")
    .select(
      "id, name, agent_id, user_id, workspace_id, instruction, delivery_channel_id, " +
        "output_bundle_id, output_retention, ends_after_runs, runs_done, status",
    )
    .eq("id", run.routine_id)
    .maybeSingle();
  if (routineError) throw new Error(`routine lookup failed: ${routineError.message}`);
  if (!routineRow) {
    // Deleted while it waited; its runs went with it, so there is nothing to
    // write either. Unreachable in practice — the cascade removes this row.
    return;
  }
  const routine = routineRow as unknown as HeldRoutine;

  const { data: agent } = await deps.db
    .from("agents")
    .select("model")
    .eq("id", routine.agent_id)
    .eq("workspace_id", routine.workspace_id)
    .maybeSingle();
  const model = resolveModel((agent?.model as string | null) ?? null, env);

  const draft = run.summary ?? "";
  const answers = answered(tasks);
  const composed = await deps.compose(env, {
    model,
    instruction: routine.instruction,
    draft,
    answers,
  });
  const report = composed.text;
  const spent = spends(completionSpend(model, composed.usage, "routine"));
  const tokens = (run.tokens ?? 0) + (composed.usage ? totalTokens(composed.usage) : 0);
  const finishedAt = deps.now();
  const durationMs = finishedAt.getTime() - new Date(run.started_at).getTime();

  let sendError: string | null = null;
  try {
    const channel = await channelOf(env, deps.db, routine);
    await deliver(channel, { subject: routine.name, body: report }, deliveryDepsFrom(env), {
      event: EVENT_DELIVERED,
      routine: { id: routine.id, name: routine.name, agentId: routine.agent_id },
      // What the run read, from its own row. `triggeredBy` is the schedule's
      // because the row does not say: a held report is the same report
      // however it was started, and a receiver filing on it is told so.
      run: {
        itemsNew: run.items_new ?? 0,
        itemsOverflow: run.items_overflow ?? 0,
        triggeredBy: "schedule",
      },
    });
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  const filing = sendError ? {} : await fileHeld(env, deps.db, routine, report, run.started_at);

  const { error: runError } = await deps.db
    .from("routine_runs")
    .update({
      status: sendError ? "failed" : "ok",
      summary: sendError ? draft : report,
      error: sendError,
      tokens,
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      ...(filing.documentId ? { document_id: filing.documentId } : {}),
      ...(filing.note ? { filing_note: filing.note } : {}),
    })
    .eq("id", run.id)
    .eq("status", "waiting");
  if (runError)
    console.error("could not record a held routine run's report", run.id, runError.code);

  if (spent.length > 0 || (filing.spend?.length ?? 0) > 0) {
    try {
      await entitlementsFor(env).record(routine.workspace_id, [...spent, ...(filing.spend ?? [])], {
        userId: routine.user_id,
        routineRunId: run.id,
      });
    } catch (err) {
      console.error("failed to record a held routine run's credits", run.id, err);
    }
  }

  // A series spends a morning only when one was delivered — `finish`'s rule,
  // applied here because this is where a held run is delivered.
  if (!sendError && routine.ends_after_runs != null) {
    const done = routine.runs_done + 1;
    const patch: Record<string, unknown> = { runs_done: done };
    if (done >= routine.ends_after_runs && routine.status === "active") patch.status = "completed";
    const { error } = await deps.db.from("routines").update(patch).eq("id", routine.id);
    if (error) console.error("could not count a held routine run", run.id, error.code);
  }
}

/**
 * What the browser answered, one entry per task the report should mention.
 *
 * A task that a take-over replaced (`retry_of`) is left out: the person took
 * the browser and the retry is the attempt that counts. Anything still
 * unanswered — only on an overdue run — is said to be unanswered.
 */
export function answered(tasks: HeldTask[]): Array<{ task: string; answer: string }> {
  const retried = new Set(tasks.map((t) => t.retry_of).filter(Boolean));
  return tasks
    .filter((t) => !retried.has(t.id))
    .map((t) => {
      if (UNANSWERED.includes(t.status)) {
        return { task: t.task, answer: "(no answer yet: the browser had not finished in time)" };
      }
      const said = (t.output ?? "").trim();
      if (t.status === "finished" && said) {
        return { task: t.task, answer: said.slice(0, ANSWER_CHARS) };
      }
      const why = (t.error ?? "").trim() || "it stopped without an answer";
      return {
        task: t.task,
        answer: said
          ? `${said.slice(0, ANSWER_CHARS)}\n(did not finish: ${why})`
          : `(did not finish: ${why})`,
      };
    });
}

const COMPOSE_SYSTEM = [
  "You wrote the report below for a scheduled routine while a browser was still looking things",
  "up for it. The browser has now answered. Rewrite the report so that it includes what the",
  "browser found: keep everything in the draft that is still true, replace any line saying the",
  "browser is still checking with what it found, and say plainly what it could not do. Every",
  "fact you add must come from the browser's answers below. Do not mention browsers, tasks or",
  "tools unless the draft already does. Write in the language of the draft. Write only the",
  "report.",
].join(" ");

/**
 * The draft with the answers written in — one model call, and a plain
 * appendix if the call fails, so a held report is never lost to a provider
 * hiccup at the end of a wait.
 */
export async function composeReport(
  env: RoutineEnv,
  input: {
    model: string;
    instruction: string;
    draft: string;
    answers: Array<{ task: string; answer: string }>;
  },
): Promise<{ text: string; usage: CompletionUsage | null }> {
  if (input.answers.length === 0) return { text: input.draft, usage: null };
  const listed = input.answers
    .map((a, i) => `${i + 1}. Asked: ${a.task}\nAnswer:\n${a.answer}`)
    .join("\n\n");
  try {
    const { text, usage } = await complete(env, {
      model: input.model,
      reasoningEffort: "minimal",
      messages: [
        { role: "system", content: COMPOSE_SYSTEM },
        {
          // `user`, for the reason the routine's own material is: a browser's
          // answer is text a web page chose.
          role: "user",
          content:
            `The routine's instruction: ${input.instruction}\n\n` +
            `The draft report:\n\n${input.draft}\n\n` +
            `What the browser answered:\n\n${listed}`,
        },
      ],
    });
    const said = text.trim();
    return { text: said || appendix(input.draft, input.answers), usage };
  } catch (err) {
    console.error("could not write a browser's answers into a held report; appending them", err);
    return { text: appendix(input.draft, input.answers), usage: null };
  }
}

function appendix(draft: string, answers: Array<{ task: string; answer: string }>): string {
  const list = answers.map((a) => `**${a.task}**\n${a.answer}`).join("\n\n");
  return draft.trim() ? `${draft.trim()}\n\n---\n\n${list}` : list;
}

/** The routine's own channel, scoped from its row the way the executor's is. */
async function channelOf(env: RoutineEnv, db: SupabaseClient, routine: HeldRoutine) {
  const { data: channel, error } = await db
    .from("delivery_channels")
    .select(`${CONFIRMABLE_COLUMNS}, disabled_at`)
    .eq("id", routine.delivery_channel_id)
    .eq("user_id", routine.user_id)
    .maybeSingle();
  if (error) throw new Error(`delivery channel lookup failed: ${error.message}`);
  if (!channel) throw new Error("delivery channel missing");
  if ((channel as { disabled_at?: string | null }).disabled_at) {
    throw new Error("delivery channel disabled: the API key that set it up was revoked");
  }
  return readyForDelivery(env, channel as unknown as ConfirmableChannel);
}

/**
 * The executor's `fileOutput`, for a report delivered here. Same three
 * outcomes: nothing to file, a note saying why not, or a document.
 */
async function fileHeld(
  env: RoutineEnv,
  db: SupabaseClient,
  routine: HeldRoutine,
  report: string,
  startedAt: string,
): Promise<{ documentId?: string; note?: string; spend?: Spend[] }> {
  if (!routine.output_bundle_id) return {};
  if (!canFileDocuments(env)) return { note: NOTE_NO_DOCUMENT_STORE };
  const { data: member } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", routine.workspace_id)
    .eq("user_id", routine.user_id)
    .maybeSingle();
  if (!member || member.role === "viewer") return { note: NOTE_VIEWER };
  try {
    const result = await fileRoutineOutput(db, env, {
      routineId: routine.id,
      routineName: routine.name,
      workspaceId: routine.workspace_id,
      bundleId: routine.output_bundle_id,
      retention: routine.output_retention ?? 52,
      summary: report,
      at: new Date(startedAt),
    });
    return result.filed
      ? {
          documentId: result.documentId,
          spend: spends(
            embeddingSpend(
              embeddingModel(env as { EMBEDDING_MODEL?: string }),
              result.indexTokens,
              "index",
            ),
          ),
        }
      : { note: result.note };
  } catch (err) {
    return { note: `not filed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
