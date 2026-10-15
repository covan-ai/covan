import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { hasBrowserKey } from "./client";
import { deliverBrowserTask } from "./deliver";
import type { BrowserTaskRow } from "./poller";
import type { LiveState } from "./sessions";
import { finishedRun, settleBrowserTask, type SettleDeps } from "./settle";
import { isTerminalRun, runEvents, runStatus, runSummary, type RunEvent } from "./v4";

/**
 * The open tab's clock: what `GET /sessions/:id/browser-tasks` does on every
 * three-second poll.
 *
 * The cron poller looks every five minutes, which is a fine latency for an
 * answer nobody is waiting on and a long one for a person watching the panel
 * beside the conversation. So while a tab is open it asks the provider itself:
 * the run's one-word status, its new events, and — the moment the run has
 * ended — its summary, settled inline through `settleBrowserTask`. The cron
 * stays as the fallback, and the settle's conditional claim is what keeps the
 * two from both delivering (`settle.ts`).
 *
 * **Through the service role, scoped by hand.** `provider_run_id`,
 * `provider_browser_id` and `events_cursor` are granted to no client role
 * (0073, 0078), so none of this can be done with the caller's client. The
 * route has already read the conversation through `c.get("db")` — RLS says
 * whether the caller may see it at all — and everything here is narrowed to
 * that conversation AND the caller's own user id: a colleague in a shared
 * chat sees the answers, which are ordinary messages, and never polls or
 * settles somebody else's browser.
 *
 * **What leaves here is a DTO with no provider id in it.** `browserReady` is
 * whether `provider_browser_id` is set, as a boolean; the id itself, the run,
 * the session and the cursor stay in this file.
 *
 * **Subrequests, for the Workers Free budget.** A poll of a running run costs
 * the task read, the browser read, the status, the events and at most one
 * write: 5. The poll that sees it end skips the events and costs the two
 * reads, the status and the summary, then the settle: its claim, handing the
 * browser back, and the delivery (`deliver.ts`: session check, agent read,
 * model call, message insert, session touch, channel read, the nudge) — about
 * 13 in all, once per run, and 2 more in the rare case that no earlier poll
 * named the run's browser (`settle.ts`'s `recordOpenBrowser`, the idle sweep's
 * marker). Only the newest unsettled run is polled, which is
 * the only one `browse` lets there be (ruling R13); anything older is the
 * cron's.
 */

/** How many of a poll's new events the panel is shown. */
export const EVENTS_SHOWN = 8;

/** The longest line an event becomes. */
export const EVENT_TEXT_MAX = 120;

/** One line of what the agent is doing, for the panel. */
export type BrowserEventLine = { ts: string; type: string; text: string };

/** The browser beside the conversation, as the panel draws it. */
export type BrowserPanelSession = {
  id: string;
  liveState: LiveState;
  humanSince: number | null;
  /** Whether the provider has reported a browser for this session yet. Never the id. */
  browserReady: boolean;
};

export type LiveBrowser = {
  session: BrowserPanelSession | null;
  events: BrowserEventLine[];
  /** True when this poll settled a run and put its answer in the conversation. */
  delivered: boolean;
};

export type LiveDeps = SettleDeps;

const TASK_COLUMNS =
  "id, workspace_id, agent_id, user_id, session_id, provider_task_id, provider_run_id, " +
  "browser_session_id, api_version, task, status, poll_count, created_at, retry_of";

const SESSION_COLUMNS = "id, live_state, human_since, provider_browser_id, events_cursor";

const BROWSER_EVENT_TYPES = new Set(["browser.ready", "browser.reattached", "browser.attached"]);

/**
 * The provider's own machinery, which the panel does not show (Task 3.4).
 * Every type seen in the end-to-end runs that says nothing to the person:
 * queueing, the worker and its workspace, each model call, the browser being
 * handed over and back, and what the provider keeps after a run.
 */
const SILENT_EVENT_TYPES = new Set([
  "run.created",
  "run.dispatching",
  "run.dispatched",
  "worker.started",
  "workspace.ready",
  "core.spawn",
  "llm.request",
  "llm.response",
  "browser.attached",
  "outputs.promoted",
  "state.promoted",
  "run.completed",
  "browser.released",
  "worker.session_released",
]);

/**
 * The provider agent's tools whose steps are not shown: loading a skill, and
 * the shell it types a saved login through. Every other tool step is shown by
 * its own description.
 */
const HIDDEN_TOOLS = new Set(["skill", "bash"]);

/** A key naming an id — ours or the provider's — which is never the line shown. */
const ID_KEY = /(^id$|_id$|Id$)/;

/** A value that is a URL and nothing else: a live view or a CDP socket looks like this. */
const BARE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i;

/**
 * The line an event becomes: the first string-valued field of its `data`, cut
 * to `EVENT_TEXT_MAX`.
 *
 * The fallback for a type `eventLine`'s catalogue does not know: the provider
 * publishes none, so a new type is rendered rather than dropped, and one with
 * nothing to say is an empty line under its type. Two kinds of field are
 * passed over. Ids,
 * because `browser.ready`'s one remaining field is the provider's browser id,
 * granted to no client role. And bare URLs — `runEvents` already strips every
 * key known to carry a live or CDP URL, and this is the second belt: "Treat
 * the URL as a credential" is the provider's own sentence, and a field it adds
 * next month under a new name should not become the panel's caption.
 */
export function eventText(data: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || ID_KEY.test(key) || BARE_URL.test(text)) continue;
    return cut(text);
  }
  return "";
}

function cut(text: string): string {
  return text.length > EVENT_TEXT_MAX ? `${text.slice(0, EVENT_TEXT_MAX - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A trimmed string that is neither empty nor a bare URL, cut short; else null. */
function shown(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || BARE_URL.test(text)) return null;
  return cut(text.replace(SOCKET_URL, "[link]").replace(LIVE_OR_CDP_URL, "[link]"));
}

/**
 * A URL inside a sentence that could be a live view or a CDP socket. Real runs
 * sent none in text (2026-10-11); this is the belt for the day one does.
 */
const SOCKET_URL = /wss?:\/\/\S+/gi;
const LIVE_OR_CDP_URL = /https?:\/\/\S*(?:live|cdp)\S*/gi;

/** The hostname of an origin such as `https://news.ycombinator.com`, or null. */
function hostOf(origin: unknown): string | null {
  try {
    return new URL(String(origin)).hostname || null;
  } catch {
    return null;
  }
}

/** JSON is the run's structured answer, which reaches the conversation on its own. */
function looksLikeJson(raw: string): boolean {
  // The answer may come in a Markdown code fence.
  const text = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "");
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The line an event becomes in the panel, or null for one it does not show.
 *
 * Task 3.4's catalogue, from the event types real v4 runs sent (recorded in
 * `v4.ts`). The agent's steps are a `core.event` each: a browser step is shown
 * by the provider agent's own description of it, and what the agent says it
 * will do is shown as said, but not its JSON answer, its reasoning, its step
 * boundaries, loading a skill or the shell it types a saved login through. A
 * saved login typed is shown by its host and which half it was, never the
 * alias. A type not in the catalogue keeps the generic `eventText` line, so a
 * new one is seen rather than dropped.
 */
export function eventLine(event: RunEvent): string | null {
  const { type, data } = event;
  if (SILENT_EVENT_TYPES.has(type)) return null;
  if (type === "browser.ready") return "The browser is ready";
  if (type === "browser.reattached") return "Back in the same browser";
  if (type === "secret.typed") {
    const secret = asRecord(data.secret);
    const host = hostOf(secret.origin);
    if (!host) return "Typed a saved login";
    const alias = String(secret.alias ?? "");
    const half = alias.endsWith("_username")
      ? "username"
      : alias.endsWith("_password")
        ? "password"
        : "login";
    return `Typed the saved ${half} into ${host}`;
  }
  if (type === "core.event") {
    const part = asRecord(data.part);
    if (part.type === "text") {
      const text = shown(part.text);
      return text && !looksLikeJson(String(part.text)) ? text : null;
    }
    if (part.type === "tool" && !HIDDEN_TOOLS.has(String(part.tool))) {
      return shown(asRecord(asRecord(part.state).input).description);
    }
    return null;
  }
  return eventText(data);
}

function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

function toLiveState(raw: unknown): LiveState {
  return raw === "human" || raw === "agent" ? raw : "none";
}

/** A cursor that is a whole, non-negative number, or null. 1.1's parser can yield NaN. */
function cursorOf(raw: unknown): number | null {
  // `Number(null)` is 0, which is a cursor; an absent one is not.
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

type SessionRow = {
  id: string;
  liveState: LiveState;
  humanSince: string | null;
  browserId: string | null;
  cursor: number;
};

async function readSession(
  db: SupabaseClient,
  input: { chatSessionId: string; userId: string },
): Promise<SessionRow | null> {
  const { data, error } = await db
    .from("browser_sessions")
    .select(SESSION_COLUMNS)
    .eq("chat_session_id", input.chatSessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) {
    console.error("could not read a conversation's browser", problem(error));
    return null;
  }
  if (!data) return null;
  return {
    id: String(data.id),
    liveState: toLiveState(data.live_state),
    humanSince: typeof data.human_since === "string" ? data.human_since : null,
    browserId:
      typeof data.provider_browser_id === "string" && data.provider_browser_id
        ? data.provider_browser_id
        : null,
    cursor: cursorOf(data.events_cursor) ?? 0,
  };
}

async function readRunningTask(
  db: SupabaseClient,
  input: { chatSessionId: string; userId: string },
): Promise<BrowserTaskRow | null> {
  const { data, error } = await db
    .from("browser_tasks")
    .select(TASK_COLUMNS)
    .eq("session_id", input.chatSessionId)
    .eq("user_id", input.userId)
    .eq("api_version", "v4")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("could not read a conversation's running browser task", problem(error));
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? (data[0] as unknown as BrowserTaskRow) : null;
}

/**
 * Read the run's new events, remember the browser they name and how far they
 * go, and answer the lines the panel shows.
 *
 * The write is a compare-and-set on the cursor this poll read: two open tabs
 * read the same delta and one of them records it, and a run started since
 * (`recordRunStart` puts the cursor back to 0) is not overwritten with the old
 * run's position.
 */
async function drainEvents(
  env: RoutineEnv,
  db: SupabaseClient,
  session: SessionRow,
  runId: string,
): Promise<BrowserEventLine[]> {
  const page = await runEvents(env, runId, session.cursor, {
    signal: AbortSignal.timeout(10_000),
  });
  if (page.kind === "error") {
    console.warn("could not read a browser run's events", page.status);
    return [];
  }

  const { events, nextAfter } = page.value;
  let next = cursorOf(nextAfter);
  if (next === null) {
    for (const event of events) {
      const id = cursorOf(event.id);
      if (id !== null && (next === null || id > next)) next = id;
    }
  }

  let browserId: string | null = null;
  for (const event of events) {
    const id = event.data.browser_session_id;
    if (BROWSER_EVENT_TYPES.has(event.type) && typeof id === "string" && id) browserId = id;
  }

  const patch: Record<string, unknown> = {};
  if (next !== null && next > session.cursor) patch.events_cursor = next;
  if (browserId && browserId !== session.browserId) patch.provider_browser_id = browserId;
  if (Object.keys(patch).length > 0) {
    const { data: written, error } = await db
      .from("browser_sessions")
      .update(patch)
      .eq("id", session.id)
      .eq("events_cursor", session.cursor)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("could not record a browser's progress", problem(error));
    } else if (written && browserId) {
      session.browserId = browserId;
    }
  }

  const lines: BrowserEventLine[] = [];
  for (const event of events) {
    const text = eventLine(event);
    if (text !== null) lines.push({ ts: event.ts, type: event.type, text });
  }
  return lines.slice(-EVENTS_SHOWN);
}

/**
 * Which of a person's browsers beside a conversation are still open, as far as
 * Covan has seen: for Settings → Browser sign-ins (Task 3.2, ruling R48),
 * which lists the browsers somebody could still stop.
 *
 * `browserReady`'s reading, for many rows at once. A browser not yet seen
 * stopped is a row naming a `provider_browser_id` — the column every confirmed
 * stop clears and the idle sweep claims on (0078) — and that column is granted
 * to no client role, so the route cannot ask it through `c.get("db")`. It has
 * read the rows through the caller's own client first, and hands over only the
 * ids RLS returned; the read here is narrowed to those ids AND the caller's
 * own user id, so an id from anywhere else answers nothing.
 *
 * **Stored state, not the provider.** One read, no call to browser-use: the
 * settings page is not where a provider call earns its subrequests, and a
 * browser the provider's own cleanup stopped without telling us is one the
 * sweep will find and clear on its next pass.
 *
 * What leaves is a set of Covan's own ids — never the browser id itself.
 *
 * @returns null when it could not tell, which the route treats as "show only
 *   what the row itself says" rather than as "none open".
 */
export async function openBrowsersAmong(
  env: RoutineEnv,
  input: { userId: string; browserSessionIds: string[] },
  overrides: { db?: SupabaseClient } = {},
): Promise<Set<string> | null> {
  const open = new Set<string>();
  if (input.browserSessionIds.length === 0) return open;
  const db = overrides.db ?? serviceClient(env);

  const { data, error } = await db
    .from("browser_sessions")
    .select("id, provider_browser_id")
    .eq("user_id", input.userId)
    .in("id", input.browserSessionIds);
  if (error) {
    console.error("could not read which browsers are still open", problem(error));
    return null;
  }
  for (const row of (data ?? []) as Array<{ id: unknown; provider_browser_id: unknown }>) {
    if (typeof row.provider_browser_id === "string" && row.provider_browser_id) {
      open.add(String(row.id));
    }
  }
  return open;
}

/** How stale `human_since` may get before the open tab moves it to now. */
export const HEARTBEAT_MS = 60_000;

/**
 * Ruling R21: human mode lasts while the tab is open.
 *
 * The sweep stops a browser ten minutes past `human_since`, which used to be
 * the moment of the take-over — so a person still signing in at minute ten
 * (a slow 2FA, an email code they went to find) had the browser stopped under
 * their hands. The open tab's poll is the proof that somebody is still there,
 * so while the row is in human hands it moves `human_since` to now, at most
 * once a minute; the sweep's ten minutes then count from the tab going quiet.
 * The provider's four-hour bound is `human_started_at`, which this never
 * touches.
 *
 * A compare-and-set on the clock this poll read, and only while the row is
 * still `human`: a Done that landed meanwhile has moved it to `agent`, and a
 * second open tab that already bumped it has moved the clock — neither is
 * overwritten, so two tabs make one write a minute between them. One
 * subrequest a minute, in human mode only; the poll's other cost is unchanged.
 */
async function heartbeat(
  db: SupabaseClient,
  session: SessionRow,
  userId: string,
  now: Date,
): Promise<void> {
  if (session.liveState !== "human" || !session.humanSince) return;
  const since = Date.parse(session.humanSince);
  if (Number.isFinite(since) && now.getTime() - since <= HEARTBEAT_MS) return;
  const { data: bumped, error } = await db
    .from("browser_sessions")
    .update({ human_since: now.toISOString() })
    .eq("id", session.id)
    .eq("user_id", userId)
    .eq("live_state", "human")
    .eq("human_since", session.humanSince)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("could not keep a person's browser open", problem(error));
    return;
  }
  if (bumped) session.humanSince = now.toISOString();
}

/**
 * One poll from an open tab: the caller's browser in this conversation, its
 * newest run's progress, and the run settled if it has ended.
 *
 * Never throws for the provider's sake: a status or events call that fails is
 * a poll that shows nothing new, and the next one — or the cron — tries again.
 */
export async function pollConversationBrowser(
  env: RoutineEnv,
  input: { chatSessionId: string; userId: string },
  overrides: Partial<LiveDeps> = {},
): Promise<LiveBrowser> {
  const db = overrides.db ?? serviceClient(env);
  const deps: SettleDeps = {
    db,
    now: overrides.now ?? (() => new Date()),
    deliver: overrides.deliver ?? deliverBrowserTask,
  };

  const session = await readSession(db, input);
  if (session) await heartbeat(db, session, input.userId, deps.now());
  let events: BrowserEventLine[] = [];
  let delivered = false;

  const task = hasBrowserKey(env) ? await readRunningTask(db, input) : null;
  if (task) {
    const runId = task.provider_run_id || task.provider_task_id;
    const status = await runStatus(env, runId, { signal: AbortSignal.timeout(10_000) });
    if (status.kind === "error") {
      // A 404 included: ending the row is the cron's call, made once, rather
      // than every three seconds from every open tab.
      console.warn("could not read a browser run's status", status.status);
    } else if (isTerminalRun(status.value.status)) {
      const summary = await runSummary(env, runId, { signal: AbortSignal.timeout(10_000) });
      if (summary.kind === "error") {
        console.warn("could not read a finished browser run", summary.status);
      } else {
        delivered = await settleBrowserTask(env, task, finishedRun(summary.value), {
          ...deps,
          // The settle may name the browser the session row lacked when it
          // was read above; `browserReady` must say what it wrote, or the
          // panel's sign-in prompt waits for a refocus to appear.
          onBrowserNamed: (id) => {
            if (session && task.browser_session_id === session.id) session.browserId = id;
          },
        });
        // The settle let go of the browser only from `agent`; say what it
        // wrote rather than read the row a third time.
        if (delivered && session?.liveState === "agent") session.liveState = "none";
      }
    } else if (session && task.browser_session_id === session.id) {
      events = await drainEvents(env, db, session, runId);
    }
  }

  return {
    session: session
      ? {
          id: session.id,
          liveState: session.liveState,
          humanSince: session.humanSince ? new Date(session.humanSince).getTime() : null,
          browserReady: session.browserId !== null,
        }
      : null,
    events,
    delivered,
  };
}

/**
 * The server's own clock for a conversation's browser run, for when no tab is
 * open to be one.
 *
 * The open tab settles a finished run within three seconds; with the tab
 * closed the cron did, every five minutes, behind a four-minute poll interval
 * — so an answer that took the browser two minutes arrived after seven, and
 * looked to the person who came back like a run that had stopped. The turn's
 * host (`lib/turns`) calls this every few seconds after a turn that started a
 * browser, until the run has ended.
 *
 * Narrower than `pollConversationBrowser` on purpose. No heartbeat: R21 makes
 * human mode last while a *tab* is open, and the server calling is not
 * somebody being there. No events: the cursor is the panel's, and draining it
 * here would take lines from the tab that is about to show them. Only the
 * settle, which `settleBrowserTask`'s conditional claim makes safe to race
 * against the tab and the cron.
 *
 * @returns whether there is still a run to follow.
 */
export async function settleConversationBrowser(
  env: RoutineEnv,
  input: { chatSessionId: string; userId: string },
  overrides: Partial<LiveDeps> = {},
): Promise<{ running: boolean }> {
  if (!hasBrowserKey(env)) return { running: false };
  const db = overrides.db ?? serviceClient(env);
  const deps: SettleDeps = {
    db,
    now: overrides.now ?? (() => new Date()),
    deliver: overrides.deliver ?? deliverBrowserTask,
  };

  const task = await readRunningTask(db, input);
  if (!task) return { running: false };
  // Queued behind another run: nothing to ask the provider about yet, and the
  // cron is what starts it.
  if (task.status === "queued") return { running: true };
  const runId = task.provider_run_id || task.provider_task_id;
  if (!runId) return { running: true };

  const status = await runStatus(env, runId, { signal: AbortSignal.timeout(10_000) });
  if (status.kind === "error") {
    console.warn("could not read a browser run's status", status.status);
    return { running: true };
  }
  if (!isTerminalRun(status.value.status)) return { running: true };

  const summary = await runSummary(env, runId, { signal: AbortSignal.timeout(10_000) });
  if (summary.kind === "error") {
    console.warn("could not read a finished browser run", summary.status);
    return { running: true };
  }
  await settleBrowserTask(env, task, finishedRun(summary.value), deps);
  return { running: false };
}
