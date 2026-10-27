import type { SupabaseClient } from "@supabase/supabase-js";
import { NOT_STARTED } from "./queue";

/**
 * What the chat model is told about this conversation's browser tasks.
 *
 * The history it is given is text and nothing else (`lib/history.ts`), so a
 * task it started a turn ago is, to it, a sentence it once wrote. On
 * 2026-10-11 it told the person "three tasks are running" when one was, and
 * started over a task whose answer had already arrived — it had nothing else
 * to go on. This is the something else: the rows themselves, read fresh each
 * turn, with the instruction to report from them and from nothing else.
 *
 * Read through the caller's own client: `browser_tasks` is already readable
 * by the person who started a task (0073 grants the columns read here; 0078
 * `stop_reason` and `signin_host`), and the panel reads the same rows.
 */

/** How far back a task is still worth mentioning. */
const WITHIN_MS = 24 * 60 * 60 * 1000;

/** How many, newest first. A conversation that started more is not served by a longer list. */
const SHOWN = 5;

/** How much of each task's text is shown: enough to tell them apart. */
const TASK_CHARS = 100;

/** How much of a failure's reason. */
const ERROR_CHARS = 120;

const COLUMNS = "task, status, error, stop_reason, signin_host, created_at, then_step";

type TaskRow = {
  task?: unknown;
  status?: unknown;
  error?: unknown;
  stop_reason?: unknown;
  signin_host?: unknown;
  then_step?: unknown;
};

/** How much of the step after a task. */
const THEN_CHARS = 300;

/**
 * What the agent said it would do with the answer (0117), so the turn that
 * carries on knows what it is carrying on with — and a turn asked "so?" an
 * hour later does too.
 */
function afterwards(row: TaskRow): string {
  const step = typeof row.then_step === "string" ? row.then_step.trim() : "";
  return step ? `; afterwards you said you would: "${clip(step, THEN_CHARS)}"` : "";
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Where a task stands, in words the model can repeat.
 *
 * `stop_reason` before `status` where it says more: a login wall is a failed
 * status with somebody's next move attached, and "failed" alone would send the
 * model to retry what only the person can fix. `queued` is in flight (0073:
 * accepted by the provider), not waiting its turn.
 */
function standing(row: TaskRow): string {
  const reason = typeof row.stop_reason === "string" ? row.stop_reason : null;
  const host = typeof row.signin_host === "string" ? row.signin_host : null;
  const error = typeof row.error === "string" && row.error.trim() ? row.error : null;
  if (reason === NOT_STARTED) {
    return `did not start${error ? `: ${clip(error, ERROR_CHARS)}` : ""}`;
  }
  if (reason === "login_required") {
    return `stopped at a sign-in${host ? ` on ${host}` : ""}; waiting for the person to sign in in the browser panel`;
  }
  if (reason === "handed_to_person") return "handed to the person in the browser panel";
  if (reason === "cancelled") return "cancelled";
  if (reason === "cost_cap") return "stopped at its cost limit";
  // Both delivered an answer saying what the run did, so the line points at it
  // rather than summing it up: "blocked by the site" alone was read, on
  // 2026-10-19, as "nothing was sent", two messages after two had been.
  if (reason === "partial") {
    return "stopped part-way — its answer, saying what it did and what it did not, is already a message in this conversation";
  }
  if (reason === "blocked") {
    return "stopped because, it reports, the site refused it — its answer, saying what the site showed and anything it did first, is already a message in this conversation";
  }
  switch (row.status) {
    case "waiting":
      return "waiting its turn — it starts by itself when the tasks before it are done, and its answer will arrive as a new message";
    case "queued":
    case "running":
      return "running now — its answer will arrive as a new message";
    case "finished":
      return "finished — its answer is already a message in this conversation";
    case "failed":
      return `failed${error ? `: ${clip(error, ERROR_CHARS)}` : ""}`;
    case "stopped":
      return "stopped";
    default:
      return String(row.status ?? "unknown");
  }
}

/**
 * The note, or null when the conversation has no task in the last day or the
 * read failed. A failed read is a turn without the note — what every turn was
 * before this — never a failed turn.
 */
export async function browserTaskNote(
  db: SupabaseClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("browser_tasks")
      .select(COLUMNS)
      .eq("session_id", sessionId)
      .gt("created_at", new Date(now.getTime() - WITHIN_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(SHOWN);
    if (error) {
      console.warn("could not read a conversation's browser tasks for its prompt", error.code);
      return null;
    }
    const rows = (Array.isArray(data) ? (data as TaskRow[]) : []).reverse();
    const wakeUp = await wakeUpSet(db, sessionId);
    if (rows.length === 0 && !wakeUp) return null;
    const lines = rows.map(
      (row, i) =>
        `${i + 1}. "${clip(String(row.task ?? ""), TASK_CHARS)}" — ${standing(row)}${afterwards(row)}`,
    );
    return [
      ...(rows.length > 0
        ? [
            "Browser tasks in this conversation in the last day, oldest first. This is Covan's own " +
              "record, not something the person wrote:",
            ...lines,
            "When the person asks about these tasks, answer from this list and nothing else: do not " +
              "say a task is running, waiting or done unless the list says so, and do not start one " +
              "again while it is listed as running. What a task did is in its answer message: do not " +
              "contradict it, and do not guess why a site stopped it. When a finished task says what " +
              "you would do afterwards and that is not done yet in this conversation, do it now.",
          ]
        : []),
      ...(wakeUp ? [wakeUp] : []),
    ].join("\n");
  } catch {
    console.warn("could not read a conversation's browser tasks for its prompt");
    return null;
  }
}

/**
 * The wake-up already set for this conversation (0142), as one sentence — so
 * a watched turn asked "did you check?" does not set a second timer. The
 * person's own rows only (0142 grants them), the soonest first. A read that
 * fails says nothing, as the list above does.
 */
async function wakeUpSet(db: SupabaseClient, sessionId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("continuations")
      .select("note, wake_at")
      .eq("session_id", sessionId)
      .eq("status", "waiting")
      .order("wake_at", { ascending: true })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as { note?: unknown; wake_at?: unknown };
    if (typeof row.note !== "string" || typeof row.wake_at !== "string") return null;
    const at = new Date(row.wake_at);
    const hh = String(at.getUTCHours()).padStart(2, "0");
    const mm = String(at.getUTCMinutes()).padStart(2, "0");
    return (
      `A wake-up is already set for ${hh}:${mm} UTC: "${clip(row.note, THEN_CHARS)}". Do not ` +
      "set another unless the person asks for a different time."
    );
  } catch {
    return null;
  }
}
