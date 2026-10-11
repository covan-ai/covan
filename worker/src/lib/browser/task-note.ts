import type { SupabaseClient } from "@supabase/supabase-js";

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

const COLUMNS = "task, status, error, stop_reason, signin_host, created_at";

type TaskRow = {
  task?: unknown;
  status?: unknown;
  error?: unknown;
  stop_reason?: unknown;
  signin_host?: unknown;
};

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
  if (reason === "login_required") {
    return `stopped at a sign-in${host ? ` on ${host}` : ""}; waiting for the person to sign in in the browser panel`;
  }
  if (reason === "handed_to_person") return "handed to the person in the browser panel";
  if (reason === "cancelled") return "cancelled";
  if (reason === "cost_cap") return "stopped at its cost limit";
  if (reason === "blocked") {
    return `blocked by the site${error ? `: ${clip(error, ERROR_CHARS)}` : ""}`;
  }
  switch (row.status) {
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
    if (rows.length === 0) return null;
    const lines = rows.map(
      (row, i) => `${i + 1}. "${clip(String(row.task ?? ""), TASK_CHARS)}" — ${standing(row)}`,
    );
    return [
      "Browser tasks in this conversation in the last day, oldest first. This is Covan's own " +
        "record, not something the person wrote:",
      ...lines,
      "When the person asks about these tasks, answer from this list and nothing else: do not " +
        "say a task is running, waiting or done unless the list says so, and do not start one " +
        "again while it is listed as running.",
    ].join("\n");
  } catch {
    console.warn("could not read a conversation's browser tasks for its prompt");
    return null;
  }
}
