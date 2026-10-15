import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the chat model is told about the documents being written in this
 * conversation. `lib/browser/task-note.ts`'s answer to the same problem.
 *
 * The history the model is given is text and nothing else, so a document it
 * started a turn ago is, to it, a sentence it once wrote: "it will appear here
 * in a few minutes". On 2026-10-15 a person asked "ee?" ("so?") after the
 * document had been filed, and two models in a row started writing it again
 * from scratch — one of them stuffing the whole report into the tool's
 * arguments, which streamed for half a minute with nothing on screen and was
 * cut off. This is the something else to go on: the rows, read fresh each
 * turn, with the instruction to report from them.
 *
 * Read through the caller's own client: 0102 shows a job to the person who
 * asked for it, which is the person this turn is for.
 */

/** How far back a document is still worth mentioning. */
const WITHIN_MS = 24 * 60 * 60 * 1000;

/** How many, newest first. */
const SHOWN = 5;

const TITLE_CHARS = 120;
const ERROR_CHARS = 160;

type JobRow = {
  title?: unknown;
  status?: unknown;
  error?: unknown;
  cursor?: unknown;
  outline?: unknown;
};

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Where a document stands, in words the model can repeat. */
export function documentStanding(row: JobRow): string {
  const total = Array.isArray(row.outline) ? row.outline.length : 0;
  const written = typeof row.cursor === "number" ? Math.min(row.cursor, total) : 0;
  const error = typeof row.error === "string" && row.error.trim() ? row.error : null;
  switch (row.status) {
    case "queued":
      return "being planned — its sections are about to be written";
    case "writing":
      return `being written now — ${written} of ${total} sections done; it fills in on its card in this conversation`;
    case "filing":
      return "written, and being filed in the reports bundle";
    case "ready":
      return "finished and filed in the agent's reports bundle — the person can open it, and save it as Word or PDF, from its card in this conversation";
    case "stopped":
      return `stopped by the person at ${written} of ${total} sections — they can continue it from its card`;
    case "failed":
      return `failed${error ? `: ${clip(error, ERROR_CHARS)}` : ""} — the person can try again from its card`;
    default:
      return String(row.status ?? "unknown");
  }
}

/**
 * The note, or null when the conversation has no document in the last day or
 * the read failed. A failed read is a turn without the note, never a failed
 * turn.
 */
export async function documentJobNote(
  db: SupabaseClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("document_jobs")
      .select("title, status, error, cursor, outline, created_at")
      .eq("session_id", sessionId)
      .gt("created_at", new Date(now.getTime() - WITHIN_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(SHOWN);
    if (error) {
      console.warn("could not read a conversation's documents for its prompt", error.code);
      return null;
    }
    const rows = (Array.isArray(data) ? (data as JobRow[]) : []).reverse();
    if (rows.length === 0) return null;
    const lines = rows.map(
      (row, i) =>
        `${i + 1}. "${clip(String(row.title ?? ""), TITLE_CHARS)}" — ${documentStanding(row)}`,
    );
    return [
      "Documents written in this conversation in the last day, oldest first. This is Covan's " +
        "own record, not something the person wrote:",
      ...lines,
      "When the person asks about these documents, answer from this list and nothing else. Do " +
        "not call write_document again for a document listed here unless the person asks for a " +
        "new or different one — point them to its card instead.",
    ].join("\n");
  } catch {
    console.warn("could not read a conversation's documents for its prompt");
    return null;
  }
}
