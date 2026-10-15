/**
 * Keeping the arrangement at the provider in step with the routine.
 *
 * A routine's own row says what a person wants — running or paused, waiting
 * for an event or not, binned with its agent or not. The provider has its own
 * idea, made when we last told it something. The two drift apart every time
 * somebody presses Pause, deletes an agent, restores one from the bin or
 * changes what a routine waits for, and every one of those is a moment the
 * provider has to be told. This file is the only thing that tells it.
 *
 * `syncSubscription` is the whole idea: read both, compare, make one call to
 * close the gap, write down what the provider said. It is called from every
 * road that changes a routine (`routes/routines.ts`: create, PATCH, delete,
 * the event routes) and from the sweeper here, which catches the roads that
 * do not pass through a route — an agent binned or restored (0040's
 * functions move `deleted_at` in SQL), a pause written by the flood guard, a
 * subscribe that failed and is due another try, an arrangement about to
 * lapse. The sweeper's claim (0108's `claim_event_subscriptions`) is the same
 * comparison in SQL, so the two cannot disagree about what "out of step"
 * means.
 *
 * WHY THE SERVICE ROLE. 0108 gives no client role a write on
 * `routine_event_subscriptions` and no sight of `external_id` or
 * `secret_ciphertext`, for the reasons it gives at length — and unsubscribing
 * needs both. Every function here takes a routine id that a route has already
 * resolved through the caller's own client (or that a claim handed the
 * sweeper), and every read and write is keyed to that one id.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import { decryptSecret, encryptSecret } from "../../secret-box";
import {
  EVENT_REGISTRY,
  EventSourceError,
  type AdapterContext,
  type EventAdapter,
  type EventRegistry,
  type SubscribeResult,
  type SubscriptionRow,
  type SubscriptionStatus,
} from "./adapter";
import type { EventChoice, EventTypeDef } from "./catalog";

export type LifecycleDeps = {
  db?: SupabaseClient;
  registry?: EventRegistry;
  now?: () => Date;
};

/** Everything the engine reads, secret included. Never sent to a client. */
export const SUBSCRIPTION_COLUMNS =
  "routine_id, provider, event_type, config, external_id, secret_ciphertext, state, status, " +
  "status_detail, expires_at, attempts";

/** The routine's half of the comparison. */
type RoutineState = {
  id: string;
  user_id: string;
  workspace_id: string;
  status: string;
  trigger_kind: string;
  deleted_at: string | null;
};

/**
 * How long a failed subscribe waits before the sweeper tries again: five
 * minutes, doubling, never more than a day. A provider that is down for an
 * hour is retried a handful of times; a refusal that will never change stops
 * costing anything worth counting within a day, without ever being given up
 * on — the person may fix the cause without telling us.
 */
export function retryDelayMs(attempts: number): number {
  const base = 5 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), 24 * 60 * 60_000);
}

/** Renewed when it lapses within this long, so it is never renewed late. */
const RENEW_AHEAD_MS = 24 * 60 * 60_000;

export type SyncResult = { status: SubscriptionStatus | null; detail: string | null };

/**
 * Make the provider agree with the routine, once.
 *
 * Answers what the row says afterwards — `null` when there is no row, or when
 * the routine no longer waits for an event and the row was removed.
 */
export async function syncSubscription(
  env: RoutineEnv,
  routineId: string,
  deps: LifecycleDeps = {},
): Promise<SyncResult> {
  const db = deps.db ?? serviceClient(env);
  const registry = deps.registry ?? EVENT_REGISTRY;
  const now = deps.now ?? (() => new Date());

  const sub = await readSubscription(db, routineId);
  if (!sub) return { status: null, detail: null };

  const { data: routine, error } = await db
    .from("routines")
    .select("id, user_id, workspace_id, status, trigger_kind, deleted_at")
    .eq("id", routineId)
    .maybeSingle();
  if (error) throw new Error(`could not read the routine: ${error.message}`);

  // A routine that stopped waiting for an event — or stopped existing, which
  // the cascade normally makes impossible to observe — has nothing to keep.
  if (!routine || (routine as RoutineState).trigger_kind !== "event") {
    await release(env, db, registry, sub, routine as RoutineState | null);
    return { status: null, detail: null };
  }
  const state = routine as RoutineState;

  const def = registry.eventType(sub.event_type);
  const adapter = registry.adapterFor(sub.provider);
  if (!def || !adapter || !adapter.isConfigured(env)) {
    // Said rather than retried in silence. The usual cause is a build or a
    // deployment that stopped offering a provider — a key removed, an
    // adapter moved — and the person reading the routine's page is owed the
    // reason it stopped, not a status that never leaves `pending`.
    const what = def ? `${def.app} events` : "this kind of event";
    return markFailed(db, sub, now, `This deployment can no longer listen for ${what}.`);
  }

  const ctx = await contextFor(env, state, sub, def);
  const wanted = state.status === "active" && state.deleted_at === null;

  try {
    if (!wanted) {
      // Paused, binned, finished. Told to stop where the provider can be told
      // without forgetting, so Resume does not need a fresh subscribe — and a
      // row that never got as far as the provider has nothing to stop.
      if (sub.external_id) await adapter.setEnabled(ctx, false);
      return write(db, sub, { status: "disabled" });
    }

    if (sub.status === "expired") {
      // The connection behind it lapsed. No call here can fix that; the
      // person reconnects, and choosing the event again replaces this row.
      return { status: "expired", detail: sub.status_detail };
    }

    if (!sub.external_id || sub.status === "pending" || sub.status === "failed") {
      const result = await adapter.subscribe(ctx);
      return write(db, sub, { status: "active", result, env });
    }

    if (sub.status === "disabled") {
      const result = await adapter.setEnabled(ctx, true);
      return write(db, sub, { status: "active", result: result ?? undefined, env });
    }

    // Active and wanted. The one thing left is a lease about to run out.
    if (
      adapter.renew &&
      sub.expires_at &&
      Date.parse(sub.expires_at) - now().getTime() <= RENEW_AHEAD_MS
    ) {
      const result = await adapter.renew(ctx);
      return write(db, sub, { status: "active", result, env });
    }
    return write(db, sub, { status: "active" });
  } catch (err) {
    if (err instanceof EventSourceError) {
      return markFailed(db, sub, now, err.message, err.expired);
    }
    console.error(`event subscription ${routineId} (${sub.event_type}) failed to sync`, err);
    return markFailed(
      db,
      sub,
      now,
      `Could not reach ${def.app} to set this up. Covan will keep trying.`,
    );
  }
}

/**
 * Stop listening and forget the row. Called before a routine is deleted —
 * the cascade would take the row, and with it the only record of what to
 * unsubscribe — and when a routine is given a different event.
 *
 * The unsubscribe is best-effort and the delete is not. A provider that cannot
 * be reached right now must not keep a routine alive that somebody deleted;
 * the arrangement it leaves behind is the case 0108's header describes, which
 * each adapter answers by cancelling at the source the next time it delivers.
 */
export async function releaseSubscription(
  env: RoutineEnv,
  routineId: string,
  deps: LifecycleDeps = {},
): Promise<void> {
  const db = deps.db ?? serviceClient(env);
  const registry = deps.registry ?? EVENT_REGISTRY;
  const sub = await readSubscription(db, routineId);
  if (!sub) return;
  const { data: routine } = await db
    .from("routines")
    .select("id, user_id, workspace_id, status, trigger_kind, deleted_at")
    .eq("id", routineId)
    .maybeSingle();
  await release(env, db, registry, sub, (routine as RoutineState | null) ?? null);
}

/**
 * Point a routine at a different event — or at its first one.
 *
 * Release-then-insert rather than an update in place, because nothing about
 * the old arrangement may carry over: an `external_id` left from a Gmail
 * trigger would be "unsubscribed" the next time a Slack one is changed, at the
 * wrong provider. The primary key makes the replacement atomic from a reader's
 * point of view — there is never a moment with two rows.
 *
 * `config` is the choice as `parseEventChoice` left it, plus whatever the
 * route resolved (`connectionId`). Nothing here re-validates it; the route did,
 * through the caller's own client.
 */
export async function replaceSubscription(
  env: RoutineEnv,
  routineId: string,
  choice: EventChoice,
  deps: LifecycleDeps = {},
): Promise<SyncResult> {
  const db = deps.db ?? serviceClient(env);
  await releaseSubscription(env, routineId, { ...deps, db });

  const { error } = await db.from("routine_event_subscriptions").insert({
    routine_id: routineId,
    provider: choice.def.provider,
    event_type: choice.def.id,
    config: choice.config,
    status: "pending",
  });
  if (error) throw new Error(`could not record the event subscription: ${error.message}`);

  return syncSubscription(env, routineId, { ...deps, db });
}

/**
 * The cron's share: up to three subscriptions out of step, each brought back
 * into it. Three because a sync is a handful of subrequests — two reads, a
 * provider call, a write — and the tick it shares has fifty (`background.ts`).
 * An idle tick costs the one claim.
 */
export async function sweepEventSubscriptions(
  env: RoutineEnv,
  deps: LifecycleDeps = {},
): Promise<{ claimed: number }> {
  const db = deps.db ?? serviceClient(env);
  const { data, error } = await db.rpc("claim_event_subscriptions", { p_limit: 3 });
  if (error) throw new Error(`claim_event_subscriptions failed: ${error.message}`);
  const claimed = (data ?? []) as Array<{ routine_id: string }>;

  // One that throws must not strand the others under the claim's lease.
  const results = await Promise.allSettled(
    claimed.map((row) => syncSubscription(env, row.routine_id, { ...deps, db })),
  );
  for (const result of results) {
    if (result.status === "rejected") console.error("event subscription sweep", result.reason);
  }
  return { claimed: claimed.length };
}

// ---- internals -------------------------------------------------------------

async function readSubscription(
  db: SupabaseClient,
  routineId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await db
    .from("routine_event_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("routine_id", routineId)
    .maybeSingle();
  if (error) throw new Error(`could not read the event subscription: ${error.message}`);
  return (data as SubscriptionRow | null) ?? null;
}

async function contextFor(
  env: RoutineEnv,
  routine: Pick<RoutineState, "id" | "user_id" | "workspace_id">,
  sub: SubscriptionRow,
  def: EventTypeDef,
): Promise<AdapterContext> {
  return {
    env,
    routine: { id: routine.id, user_id: routine.user_id, workspace_id: routine.workspace_id },
    subscription: sub,
    eventType: def,
    secret: sub.secret_ciphertext
      ? await decryptSecret(sub.secret_ciphertext, env.ROUTINE_SECRET_KEY)
      : null,
  };
}

async function release(
  env: RoutineEnv,
  db: SupabaseClient,
  registry: EventRegistry,
  sub: SubscriptionRow,
  routine: RoutineState | null,
): Promise<void> {
  const adapter: EventAdapter | undefined = registry.adapterFor(sub.provider);
  const def = registry.eventType(sub.event_type);
  if (sub.external_id && adapter && def && adapter.isConfigured(env)) {
    try {
      const ctx = await contextFor(
        env,
        routine ?? { id: sub.routine_id, user_id: "", workspace_id: "" },
        sub,
        def,
      );
      await adapter.unsubscribe(ctx);
    } catch (err) {
      console.error(`could not unsubscribe ${sub.routine_id} at ${sub.provider}`, err);
    }
  }
  const { error } = await db
    .from("routine_event_subscriptions")
    .delete()
    .eq("routine_id", sub.routine_id);
  if (error) throw new Error(`could not remove the event subscription: ${error.message}`);
}

/**
 * Write what the provider said. Success clears the failure bookkeeping —
 * attempts, the sentence, the retry clock — because a row that works again
 * should look like one that always did.
 */
async function write(
  db: SupabaseClient,
  sub: SubscriptionRow,
  next: { status: SubscriptionStatus; result?: SubscribeResult; env?: RoutineEnv },
): Promise<SyncResult> {
  const patch: Record<string, unknown> = {
    status: next.status,
    status_detail: null,
    attempts: 0,
    next_attempt_at: null,
  };
  const result = next.result;
  if (result) {
    if (result.externalId !== undefined) patch.external_id = result.externalId;
    if (result.state !== undefined) patch.state = result.state;
    if (result.expiresAt !== undefined) {
      patch.expires_at = result.expiresAt ? result.expiresAt.toISOString() : null;
    }
    if (result.secret !== undefined) {
      patch.secret_ciphertext =
        result.secret === null || !next.env
          ? null
          : await encryptSecret(result.secret, next.env.ROUTINE_SECRET_KEY);
    }
  }
  const { error } = await db
    .from("routine_event_subscriptions")
    .update(patch)
    .eq("routine_id", sub.routine_id);
  if (error) throw new Error(`could not update the event subscription: ${error.message}`);
  return { status: next.status, detail: null };
}

async function markFailed(
  db: SupabaseClient,
  sub: SubscriptionRow,
  now: () => Date,
  detail: string,
  expired = false,
): Promise<SyncResult> {
  const attempts = sub.attempts + 1;
  const status: SubscriptionStatus = expired ? "expired" : "failed";
  const { error } = await db
    .from("routine_event_subscriptions")
    .update({
      status,
      status_detail: detail,
      attempts,
      // An expired row is not the sweeper's to retry — see `EventSourceError`.
      next_attempt_at: expired
        ? null
        : new Date(now().getTime() + retryDelayMs(attempts)).toISOString(),
    })
    .eq("routine_id", sub.routine_id);
  if (error) throw new Error(`could not record the event subscription's failure: ${error.message}`);
  return { status, detail };
}
