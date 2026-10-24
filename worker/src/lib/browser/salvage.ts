import { headroom } from "../subrequests";
import type { BrowserEnv } from "./client";
import { runEvents, type RunEvent } from "./v4";

/**
 * What a run saw before it stopped without an answer, read back from its own
 * event log.
 *
 * A run that reaches its `maxCostUsd` ends with "Could not produce output
 * matching outputSchema" and nothing else: no `result`, no `output`. Every
 * page it read is paid for, and until this file the conversation was told
 * only the error — on 2026-10-24 a run asked to look up three people's work
 * addresses across seven sites ran to the ceiling, and the person got the
 * task repeated back with the provider's sentence after it, though the run
 * had been reading result pages the whole time. The event log still holds
 * what the agent said along the way, each step's own description, and the
 * pages its last steps came back with; that is what is handed to the
 * delivery, marked as notes rather than a report, so it is never phrased as
 * an answer the run did not give.
 */

/**
 * Pages of events read at most. The provider pages forward only, so a run
 * longer than this hands on its beginning; the bound is the outbound calls,
 * not the notes, which are cut from the end below.
 */
const MAX_PAGES = 6;

/**
 * Outbound calls left untouched for what comes after: the claim, the charge,
 * the browser hand-back, the delivery's completion and its insert.
 */
const RESERVE = 8;

/** The pages kept, counted from the last step back: the earlier ones are what the agent already summarised. */
const PAGES_KEPT = 4;

/** How much of one page is kept. */
const PAGE_CHARS = 1_200;

/** How much one sentence of the agent's is kept. */
const LINE_CHARS = 400;

/** The whole of the notes, kept from the end. */
const NOTES_CHARS = 6_000;

const SOCKET_URL = /wss?:\/\/\S+/gi;
const LIVE_OR_CDP_URL = /https?:\/\/\S*(?:live|cdp)\S*/gi;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clean(value: unknown, max: number): string | null {
  const raw = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const text = raw
    .replace(SOCKET_URL, "[link]")
    .replace(LIVE_OR_CDP_URL, "[link]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The run's JSON answer, which a run at the ceiling never finished writing anyway. */
function looksLikeJson(text: string): boolean {
  return /^(```[a-z]*\s*)?[[{]/i.test(text.trim());
}

/**
 * The notes, oldest first, from a run's events: what the agent said, what
 * each browser step was for, and what the last few steps' pages held.
 *
 * The shell and skill tools are left out for the reason the panel leaves them
 * out — the shell is how a saved login is typed — and the agent's reasoning
 * arrives encrypted. Null when the log holds nothing worth handing on.
 */
export function notesOf(events: RunEvent[]): string | null {
  type Note = { line: string; page?: string };
  const notes: Note[] = [];
  for (const event of events) {
    if (event.type !== "core.event") continue;
    const part = asRecord(event.data.part);
    if (part.type === "text") {
      const said = typeof part.text === "string" && !looksLikeJson(part.text);
      const line = said ? clean(part.text, LINE_CHARS) : null;
      if (line) notes.push({ line: `Said: ${line}` });
      continue;
    }
    if (part.type === "tool" && part.tool === "browser_execute") {
      const state = asRecord(part.state);
      const step = clean(asRecord(state.input).description, LINE_CHARS);
      const page = clean(state.output, PAGE_CHARS) ?? undefined;
      if (step || page) notes.push({ line: `Step: ${step ?? "(no description)"}`, page });
    }
  }
  if (notes.length === 0) return null;

  const firstPageKept = notes.length - PAGES_KEPT;
  const lines = notes.flatMap((note, i) =>
    note.page && i >= firstPageKept ? [note.line, `Page: ${note.page}`] : [note.line],
  );
  const kept: string[] = [];
  let length = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    length += lines[i].length + 1;
    if (length > NOTES_CHARS) break;
    kept.unshift(lines[i]);
  }
  return kept.length > 0 ? kept.join("\n") : null;
}

/**
 * Read a finished run's event log and return its notes, or null.
 *
 * Never throws and never blocks the settle: a page that fails, or a Worker
 * that is running low on outbound calls, ends the reading with what was read
 * so far — the error message the run would have had without this is still
 * there.
 */
export async function salvageRun(env: BrowserEnv, runId: string): Promise<string | null> {
  const events: RunEvent[] = [];
  let after = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const left = headroom(env);
      if (left !== null && left <= RESERVE) break;
      const read = await runEvents(env, runId, after, { signal: AbortSignal.timeout(10_000) });
      if (read.kind === "error") {
        console.warn("could not read a stopped browser run's events", read.status);
        break;
      }
      events.push(...read.value.events);
      const next = read.value.nextAfter;
      if (!read.value.hasMore || next === null || next <= after) break;
      after = next;
    }
  } catch (err) {
    console.warn("could not read a stopped browser run's events", err);
  }
  return notesOf(events);
}
