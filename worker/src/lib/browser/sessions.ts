import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import type { BrowserResult } from "./client";

/**
 * The browser beside a conversation: which provider session it is, and whose
 * hands it is in.
 *
 * Until 0078 every `browse` was a stranger — a fresh browser at browser-use,
 * one task, thrown away. v4 keeps an agent SESSION alive across runs, so a
 * follow-up ("now open the second result") continues in the same tabs, and a
 * person can watch the one browser their conversation has been using. One
 * `browser_sessions` row per (chat session, person) is where Covan remembers
 * that session's id at the provider.
 *
 * **Through the service role, for `tasks.ts`'s reason and 0078's.** The row's
 * whole point is `provider_session_id`, granted to no client role: one
 * deployment-wide `BROWSER_USE_API_KEY` makes it the entire address of a
 * running browser, possibly signed into somebody's accounts. And `live_state`
 * is written by the worker alone — `human` is the state in which the panel
 * hands somebody the controls. Nothing here decides anything: every id comes
 * from `ToolContext`, resolved from the authenticated request before the tool
 * ran. The row is found by conversation AND person, and every later write is
 * keyed to the row id that read handed back, never to anything a caller sent.
 *
 * **Never a provider id in a log line.** `problem` is `takeover.ts`'s rule: a
 * database error's `details` quotes the failing row, and this row carries the
 * session id.
 */

/** Injected as `takeover.ts` injects its own; `??` against the real thing. */
export type SessionDeps = { db: SupabaseClient; now: () => Date };

function resolve(env: RoutineEnv, overrides: Partial<SessionDeps>): SessionDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
  };
}

function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Who has the controls: 0078's `live_state`. */
export type LiveState = "none" | "agent" | "human";

/**
 * The row's id, and the provider session a follow-up continues — or null,
 * which tells the caller that its run opens the browser.
 *
 * `liveState` and `runInFlight` are the two facts `browse` refuses on before it
 * calls the provider (ruling R13): the person is driving this browser, or a v4
 * run of it has not settled. Answered rather than acted on here, because
 * refusing is the tool's sentence to write, and because both have to be read
 * before the meter, which only ever charges once the provider has answered.
 *
 * `profileId` is our `browser_profiles.id` the browser was OPENED with, null
 * when it was opened without one. A follow-up sends its jar only when it is
 * this one (`jarForSession`), because the provider reads an explicit
 * `profileId` that differs from the live browser's as "not this browser".
 */
export type BrowserSessionRef = {
  id: string;
  providerSessionId: string | null;
  liveState: LiveState;
  runInFlight: boolean;
  profileId: string | null;
};

/**
 * How long a row naming no provider session may sit before another request may
 * open the browser in its place.
 *
 * `PROVISIONING_STALE_MS`'s argument, for the same three states. The claim is
 * taken before `createRun`, and the provider session is written only once the
 * run is accepted, so for the width of one HTTP request (`client.ts`'s
 * `TIMEOUT_MS`, fifteen seconds) a row names nothing because a request is
 * busy opening it. A request that died in that window leaves the row naming
 * nothing forever, and reading that only as "busy" would lock the conversation
 * out of its browser for good. Past a minute the claimant is not slow, it is
 * gone.
 */
const OPENING_STALE_MS = 60_000;

const BUSY = "this conversation's browser is being opened by another request";
const UNAVAILABLE = "could not open a browser for this conversation";

type SessionRow = {
  id: string;
  profileId: string | null;
  providerSessionId: string | null;
  liveState: LiveState;
  createdAt: string | null;
};

function toLiveState(raw: unknown): LiveState {
  return raw === "human" || raw === "agent" ? raw : "none";
}

async function readSessionRow(
  db: SupabaseClient,
  input: { chatSessionId: string; userId: string },
): Promise<{ row: SessionRow | null; failed: boolean }> {
  const { data, error } = await db
    .from("browser_sessions")
    .select("id, profile_id, provider_session_id, live_state, created_at")
    .eq("chat_session_id", input.chatSessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) {
    console.error("could not read a conversation's browser", problem(error));
    return { row: null, failed: true };
  }
  if (!data) return { row: null, failed: false };
  return {
    row: {
      id: String(data.id),
      profileId: text(data.profile_id),
      providerSessionId: text(data.provider_session_id),
      liveState: toLiveState(data.live_state),
      createdAt: text(data.created_at),
    },
    failed: false,
  };
}

/**
 * Whether a v4 run of this browser has not settled yet: a `browser_tasks` row
 * naming it, still `queued` or `running`.
 *
 * The provider would answer such a follow-up 409 ("A busy V4 session returns
 * 409"), and today's metering charges a provider error it took — so this is
 * asked first, and the 409 stays only as the backstop for a run that starts
 * between this read and the next. Keyed to the row id `readSessionRow` handed
 * back, never to anything a caller sent. `null` when the read fails, and the
 * caller refuses rather than guessing either way: guessing "no" is a charge
 * for a refusal, guessing "yes" a wrong sentence.
 */
async function runInFlight(db: SupabaseClient, browserSessionId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from("browser_tasks")
    .select("id")
    .eq("browser_session_id", browserSessionId)
    .eq("api_version", "v4")
    .in("status", ["queued", "running"])
    .limit(1);
  if (error) {
    console.error("could not read whether a browser is mid-run", problem(error));
    return null;
  }
  return Array.isArray(data) && data.length > 0;
}

/** An existing row as the caller sees it: who has it, and whether it is mid-run. */
async function existing(
  db: SupabaseClient,
  row: SessionRow,
  providerSessionId: string | null,
): Promise<BrowserResult<BrowserSessionRef>> {
  const running = await runInFlight(db, row.id);
  if (running === null) return { kind: "error", status: 500, message: UNAVAILABLE };
  return {
    kind: "ok",
    value: {
      id: row.id,
      providerSessionId,
      liveState: row.liveState,
      runInFlight: running,
      profileId: row.profileId,
    },
  };
}

/** Ready, somebody else's business, or ours to open. See `ensureBrowserSession`. */
async function finishRow(
  db: SupabaseClient,
  row: SessionRow,
  now: Date,
): Promise<BrowserResult<BrowserSessionRef>> {
  if (row.providerSessionId) return existing(db, row, row.providerSessionId);
  const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
  // `created_at` is `not null default now()`, so an unparseable one is
  // unreachable; counted as stale, because the recoverable direction is one
  // extra browser and the other is a conversation locked out for good.
  if (Number.isFinite(at) && now.getTime() - at < OPENING_STALE_MS) {
    // A request is between its claim and the provider's answer. Opening a
    // second browser now is the orphan the unique exists to prevent.
    return { kind: "error", status: 409, message: BUSY };
  }
  // Abandoned. Whatever the dead attempt may have opened cannot be named from
  // here — it was never written down — so this request opens a fresh one.
  return existing(db, row, null);
}

/**
 * Find or claim this conversation's browser, in the one order that cannot
 * leave a browser nobody can name.
 *
 * `ensureProfile`'s discipline, copied. **The row is inserted before the
 * provider is called**, with `on conflict (chat_session_id, user_id) do
 * nothing ... returning`: the first `browse` in a conversation races itself —
 * two tabs, or a retry before the first response lands — and if both opened a
 * session at browser-use, one of them would be a running browser no row names,
 * billing until the provider idles it out. An empty `returning` means somebody
 * else holds the row, so the loser re-reads instead of calling out.
 *
 * So a row is one of three things: naming a provider session (a follow-up
 * continues it), naming none while a request is opening it (409, and nothing
 * is sent to the provider), or naming none because that request died (this
 * one opens the browser instead; see `OPENING_STALE_MS`).
 *
 * `profileId` is our `browser_profiles.id`, recorded as the jar the browser
 * was opened with. Written on the claim only: a follow-up runs in the browser
 * it already has.
 */
export async function ensureBrowserSession(
  env: RoutineEnv,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string;
    chatSessionId: string;
    profileId: string | null;
  },
  overrides: Partial<SessionDeps> = {},
): Promise<BrowserResult<BrowserSessionRef>> {
  const { db, now } = resolve(env, overrides);

  const held = await readSessionRow(db, input);
  if (held.failed) return { kind: "error", status: 500, message: UNAVAILABLE };
  if (held.row) return finishRow(db, held.row, now());

  const { data: claimed, error: claimError } = await db
    .from("browser_sessions")
    .upsert(
      {
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        user_id: input.userId,
        chat_session_id: input.chatSessionId,
        profile_id: input.profileId,
      },
      { onConflict: "chat_session_id,user_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (claimError) {
    console.error("could not claim a conversation's browser", problem(claimError));
    return { kind: "error", status: 500, message: UNAVAILABLE };
  }

  // We hold the index. Nothing else can be opening this conversation's browser.
  if (claimed) {
    return {
      kind: "ok",
      value: {
        id: String(claimed.id),
        providerSessionId: null,
        liveState: "none",
        runInFlight: false,
        profileId: input.profileId,
      },
    };
  }

  // Somebody else won between our read and our insert. Re-read, and call the
  // provider zero times unless that row turns out to be abandoned.
  const won = await readSessionRow(db, input);
  if (won.failed) return { kind: "error", status: 500, message: UNAVAILABLE };
  // Claimed and already handed back: a first run that failed. Nothing to join
  // and no reason to race it.
  if (!won.row) return { kind: "error", status: 409, message: BUSY };
  return finishRow(db, won.row, now());
}

/**
 * A run has been accepted in this browser: the agent has the controls.
 *
 * Ruling R4. `live_state = 'agent'` is what makes the panel poll and the edge
 * hairline breathe, and settling the run puts it back to `none` (Task 1.4).
 * `last_run_at` is when the agent last took the browser.
 *
 * `providerSessionId` is passed only by the run that OPENED the provider
 * session, and is written only where the row names none yet — `is null`, the
 * fill-narrowing of `ensureProfile`'s `provision`. Two requests that both found
 * one abandoned claim stale can both arrive here with a session of their own;
 * the first one written is the browser this conversation keeps, and the
 * other's run still answers (its task row names its run) in a browser nothing
 * continues.
 *
 * Answers nothing. The run is already at the provider and its task already
 * recorded, so a failure here is logged rather than turned into a failed
 * turn: the answer still arrives, the panel just does not show the agent
 * working, and an unnamed session is opened afresh by the next `browse` once
 * the claim goes stale.
 */
export async function recordRunStart(
  env: RoutineEnv,
  input: {
    browserSessionId: string;
    providerSessionId?: string;
    /**
     * Our `browser_profiles.id`, when the run carries a jar. Ruling R19: the
     * first `browse` provisions the jar after the row was claimed, so the
     * claim named none, and the sweep reads `profile_id` to refresh the jar
     * after it stops the browser. Written in the same update, so it costs
     * nothing; absent, the column is left as it is.
     */
    profileId?: string;
  },
  overrides: Partial<SessionDeps> = {},
): Promise<void> {
  const { db, now } = resolve(env, overrides);
  /**
   * `events_cursor` goes back to the start because the cursor is the
   * session's and the event log is the run's: a follow-up's log is read from
   * its own beginning, and the old run's last id would skip its first events
   * (or all of them). The open tab's write of the cursor is a compare-and-set
   * on the value it read (`live.ts`), so a poll that read the old run's
   * cursor cannot put it back over this.
   */
  const started = {
    live_state: "agent",
    last_run_at: now().toISOString(),
    events_cursor: 0,
    ...(input.profileId ? { profile_id: input.profileId } : {}),
  };

  if (input.providerSessionId) {
    const { data: filled, error } = await db
      .from("browser_sessions")
      .update({ ...started, provider_session_id: input.providerSessionId })
      .eq("id", input.browserSessionId)
      .is("provider_session_id", null)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("could not record the browser a run opened", problem(error));
      return;
    }
    if (filled) return;
    // Another request's session got there first. Keep it; take the controls.
  }

  // Never over `human`: the person holds the controls (Task 1.5), and a run
  // recorded in the gap between `browse`'s refusal check and here must not
  // take the browser out of their hands. Its answer still arrives. The fill
  // above needs no such guard — it matches only a row naming no session, and
  // a take-over needs a session to take.
  const { error } = await db
    .from("browser_sessions")
    .update(started)
    .eq("id", input.browserSessionId)
    .neq("live_state", "human");
  if (error) console.error("could not record a run starting", problem(error));
}

/**
 * Give the claim back when the run that was to open the browser never started.
 *
 * Without this, a refused first run (the shared pool full, a network fault)
 * would leave a row naming nothing, and every `browse` in the next minute would
 * be told another request is opening the browser. Narrowed to a row that still
 * names no session: a row that names one names a browser, and deleting it
 * would leave that browser running with nothing able to stop it.
 */
export async function releaseBrowserSession(
  env: RoutineEnv,
  browserSessionId: string,
  overrides: Partial<SessionDeps> = {},
): Promise<void> {
  const { db } = resolve(env, overrides);
  const { error } = await db
    .from("browser_sessions")
    .delete()
    .eq("id", browserSessionId)
    .is("provider_session_id", null);
  if (error) console.error("could not hand back a browser claim", problem(error));
}
