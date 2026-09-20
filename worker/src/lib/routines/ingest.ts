/**
 * Resolving an ingest token to the routine it fires.
 *
 * This module exists so that `routes/routine-hooks.ts` never names
 * `serviceClient`. The lookup genuinely needs it — a POST from GitHub carries
 * no Covan session, so there is no `auth.uid()` for RLS to resolve, and
 * `routine_triggers.token_hash` is granted to no client role by design (0055).
 * Keeping that in one small file with one query in it is what makes the
 * exemption reviewable: the route reads as a route.
 *
 * What the token is NOT: a credential that becomes a person. `lib/api-keys.ts`
 * mints a short-lived JWT for the key's owner because an API key means "I am
 * this person". An ingest token means "I may fire this one row", which is a
 * much smaller claim, and minting a token for the owner here would be wrong
 * three times over:
 *
 * 1. It would not work. The executor writes to four tables that have no policy
 *    for `authenticated` at all — a run as the owner would be refused by the
 *    database, not helped by it.
 * 2. It would confuse two different things. A leaked API key is a leaked
 *    identity; a leaked ingest token should stay a leaked button.
 * 3. It would raise what a leak is worth from "somebody can trigger this
 *    routine" to "somebody holds a bearer token for that person".
 *
 * The run happens as the routine's owner anyway, and by construction rather
 * than by impersonation: `runRoutine` never resolves a caller. Every id it uses
 * comes off the routine row, and it re-checks `workspace_members` before it
 * does anything. The owner's allowance is charged for the same reason — the
 * executor already asks `entitlements.check(routine.user_id)`, so a poked run
 * costs its owner exactly what a scheduled one does, with no new code.
 */

import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { base64url } from "../jwt";
import type { RoutineRow } from "./executor";

/**
 * What an ingest token looks like.
 *
 * Not `covan_sk_`: `looksLikeApiKey()` matches that prefix to decide a bearer
 * token is an API key rather than a JWT, and an ingest token sent as a bearer
 * would then be looked up in the wrong table. A distinct prefix also means a
 * secret scanner can tell the two apart in somebody's CI config, where these
 * are going to end up.
 */
export const INGEST_TOKEN_PREFIX = "covan_whk_";

/** The columns `runRoutine` reads. Listed rather than `*` so a widening is deliberate. */
const ROUTINE_COLUMNS =
  "id, agent_id, user_id, workspace_id, name, source_kind, source_config, instruction, " +
  "delivery_channel_id, schedule_cron, timezone, next_run_at, cursor, consecutive_failures, " +
  "status, trigger_kind, deleted_at";

/** 32 bytes of CSPRNG, base64url — the shape `lib/api-keys.ts` settled on. */
export function generateIngestToken(): { token: string; tokenHash: Promise<string> } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = INGEST_TOKEN_PREFIX + base64url(bytes);
  return { token, tokenHash: hashIngestToken(token) };
}

/**
 * SHA-256 hex, deliberately not a password hash — the same reasoning
 * `hashApiKey` gives: the token is 32 random bytes, so there is no dictionary
 * for bcrypt's slowness to defend against, and it would cost CPU on every
 * delivery for nothing. What matters is that the database holds nothing
 * replayable.
 */
export async function hashIngestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type IngestResolution =
  | { ok: true; routine: RoutineRow }
  | { ok: false; status: 401 | 409; error: string };

/**
 * The routine this token fires, or why it does not.
 *
 * The split between 401 and 409 is about what the answer tells an unauthorised
 * caller. Every failure to resolve a token is one 401 with one sentence:
 * missing, malformed, unknown, and revoked all read identically, so the
 * endpoint cannot be used to discover which tokens exist. Past that point the
 * caller has proved they hold the token, and a 409 that says "this routine is
 * paused" tells them something they are entitled to know and can act on —
 * telling them "unauthorised" instead would send somebody hunting for a
 * credential problem that is not there.
 */
export async function resolveIngestToken(
  env: RoutineEnv,
  token: string | undefined,
): Promise<IngestResolution> {
  const unauthorised = { ok: false, status: 401, error: "unknown ingest token" } as const;
  if (!token || !token.startsWith(INGEST_TOKEN_PREFIX)) return unauthorised;

  const db = serviceClient(env);

  // Two reads rather than one embedded select. PostgREST would return the
  // routine as a nested array and the shape that comes back would have to be
  // cast through `unknown` to become a `RoutineRow` — a cast that keeps
  // compiling after somebody changes the column list, which is the one thing
  // this lookup must not do quietly.
  const { data: trigger, error } = await db
    .from("routine_triggers")
    .select("routine_id")
    .eq("token_hash", await hashIngestToken(token))
    .maybeSingle();

  // A lookup that failed is not a token that is wrong. Answering 401 here would
  // tell a correctly-configured sender to go and check its credentials because
  // our database had a bad second.
  if (error) return { ok: false, status: 409, error: "could not read that trigger" };
  if (!trigger) return unauthorised;

  const { data: row, error: routineError } = await db
    .from("routines")
    .select(ROUTINE_COLUMNS)
    .eq("id", trigger.routine_id)
    .maybeSingle();

  if (routineError) return { ok: false, status: 409, error: "could not read that routine" };

  const routine = row as (RoutineRow & TriggerState) | null;
  // A trigger whose routine is gone is indistinguishable from a token that was
  // never issued, and should be: the row is on its way out with it.
  if (!routine || routine.deleted_at) return unauthorised;

  if (routine.status !== "active") {
    return { ok: false, status: 409, error: `this routine is ${routine.status}` };
  }
  if (routine.trigger_kind === "schedule") {
    return { ok: false, status: 409, error: "this routine no longer accepts webhook triggers" };
  }

  return { ok: true, routine };
}

type TriggerState = { status: string; trigger_kind: string; deleted_at: string | null };

/**
 * Note that the trigger fired. Best-effort and deliberately fire-and-forget:
 * the run is what the caller asked for, and a routine must not fail because a
 * timestamp could not be written.
 *
 * This is the only thing written about an incoming request, and it is a clock
 * reading. The payload itself is never stored anywhere — see the executor.
 */
export async function touchTrigger(env: RoutineEnv, routineId: string): Promise<void> {
  try {
    await serviceClient(env)
      .from("routine_triggers")
      .update({ last_used_at: new Date().toISOString() })
      .eq("routine_id", routineId);
  } catch {
    // Nothing to do: the run is the point, not the bookkeeping.
  }
}
