/**
 * The one door every event comes in through, whoever sent it.
 *
 * Each provider gets its own receiving route — Composio signs one way, Slack
 * another, GitHub a third — and each route's job ends at "this request really
 * is from that provider, and it is about this subscription". From there on an
 * event is an event, and this file decides, the same way for all of them,
 * whether it runs anything:
 *
 *   1. The subscription and its routine are read with the service role,
 *      because a delivery carries no Covan caller — `routine_hooks`' reason
 *      (`ingest.ts`), one provider further away.
 *   2. Anything not running is refused: a paused or binned routine, one that
 *      stopped waiting for events, a subscription that is not `active`.
 *   3. The adapter turns the raw delivery into a paragraph the model can read,
 *      or into nothing (the bot's own message coming back round).
 *   4. The entry's filter is applied. An event that does not match opens no
 *      run, writes no row and costs nothing — which is why the filter is here,
 *      ahead of everything that does.
 *   5. The flood guard counts it (0109's `count_routine_event`), and a routine
 *      over its hourly or daily limit is paused and its owner told.
 *   6. The run is deferred through `runPokedRoutine`, exactly as a webhook's
 *      is: the membership check, the credit check, claim-before-send and
 *      delivery are the executor's, unchanged. The event's own id becomes the
 *      delivery claim (`evt:<provider>:<id>`), so a provider that delivers
 *      twice — they all do, eventually — produces one message.
 *
 * Nothing about what arrived is stored. A clock reading and two counters are
 * written; the payload reaches the model and nowhere else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import { decryptSecret } from "../../secret-box";
import { ROUTINE_COLUMNS } from "../ingest";
import type { RoutineRow } from "../executor";
import { pauseForEventFlood, runPokedRoutine } from "../dispatcher";
import { EVENT_REGISTRY, type EventRegistry, type SubscriptionRow } from "./adapter";
import { triggerLabel } from "./catalog";
import { SUBSCRIPTION_COLUMNS, syncSubscription } from "./lifecycle";

/**
 * How many events may start a routine in an hour and in a day, unless the
 * deployment says otherwise (`ROUTINE_EVENT_RUNS_PER_HOUR`,
 * `ROUTINE_EVENT_RUNS_PER_DAY`).
 *
 * The workspace's credit already bounds what a routine can spend in total —
 * `entitlements.check` runs before every model call. What it does not bound
 * is how fast, and a routine that listens to a busy channel with a filter
 * one word too wide can spend a month's credit in an afternoon before
 * anybody reads their mail. These are a fuse for that, not a budget: high
 * enough that a routine doing what it was set up to do never meets them.
 */
export const DEFAULT_EVENT_RUNS_PER_HOUR = 60;
export const DEFAULT_EVENT_RUNS_PER_DAY = 500;

export function eventRunLimits(env: RoutineEnv): { perHour: number; perDay: number } {
  const read = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    perHour: read(env.ROUTINE_EVENT_RUNS_PER_HOUR, DEFAULT_EVENT_RUNS_PER_HOUR),
    perDay: read(env.ROUTINE_EVENT_RUNS_PER_DAY, DEFAULT_EVENT_RUNS_PER_DAY),
  };
}

/** Which subscription a delivery is about, as its route established it. */
export type DeliveryTarget =
  /** The route's URL named the routine (one URL per subscription). */
  | { routineId: string }
  /** The provider names its own id for the arrangement (one URL per provider). */
  | { provider: string; externalId: string };

/**
 * What happened, for the route to answer the provider with. Every one of
 * these is a 2xx to the provider except where the route decides otherwise:
 * a provider that is told "error" retries, and retrying an event that was
 * filtered out or arrived for a paused routine would only send it again.
 *
 *   accepted  a run was started
 *   filtered  the event did not match the routine's filter
 *   ignored   the adapter said it was not an event for this routine
 *   inactive  the routine or the subscription is not running
 *   flood     over the limit; the routine is now paused
 *   unknown   no subscription matches — the route may cancel at the source
 */
export type ReceiveOutcome =
  | { status: "accepted"; eventId: string }
  | { status: "filtered" | "ignored" | "inactive" | "flood" | "unknown" };

export type ReceiveDeps = {
  db?: SupabaseClient;
  registry?: EventRegistry;
  /** `deferred(c, …)` from the route; keeps this file free of Hono. */
  defer: (work: Promise<unknown>) => void;
  /** Injected so a test can see what would have run. */
  run?: typeof runPokedRoutine;
  pause?: typeof pauseForEventFlood;
  sync?: typeof syncSubscription;
};

export async function receiveEvent(
  env: RoutineEnv,
  target: DeliveryTarget,
  raw: unknown,
  deps: ReceiveDeps,
): Promise<ReceiveOutcome> {
  const db = deps.db ?? serviceClient(env);
  const registry = deps.registry ?? EVENT_REGISTRY;
  const run = deps.run ?? runPokedRoutine;
  const pause = deps.pause ?? pauseForEventFlood;
  const sync = deps.sync ?? syncSubscription;

  // 1. The subscription, by whichever handle the route has.
  let query = db.from("routine_event_subscriptions").select(SUBSCRIPTION_COLUMNS);
  query =
    "routineId" in target
      ? query.eq("routine_id", target.routineId)
      : query.eq("provider", target.provider).eq("external_id", target.externalId);
  const { data: subRow, error: subError } = await query.maybeSingle();
  if (subError) throw new Error(`could not read the event subscription: ${subError.message}`);
  const sub = subRow as SubscriptionRow | null;
  if (!sub) return { status: "unknown" };

  const { data: routineRow, error: routineError } = await db
    .from("routines")
    .select(ROUTINE_COLUMNS)
    .eq("id", sub.routine_id)
    .maybeSingle();
  if (routineError) throw new Error(`could not read the routine: ${routineError.message}`);
  const routine = routineRow as
    (RoutineRow & { status: string; trigger_kind: string; deleted_at: string | null }) | null;

  // 2. Only a running routine waiting for exactly this.
  if (
    !routine ||
    routine.deleted_at ||
    routine.status !== "active" ||
    routine.trigger_kind !== "event" ||
    sub.status !== "active"
  ) {
    return { status: "inactive" };
  }

  const def = registry.eventType(sub.event_type);
  const adapter = registry.adapterFor(sub.provider);
  if (!def || !adapter) return { status: "inactive" };

  // 3. What happened, in a paragraph.
  const event = await adapter.normalize(raw, {
    env,
    routine: { id: routine.id, user_id: routine.user_id, workspace_id: routine.workspace_id },
    subscription: sub,
    eventType: def,
    secret: sub.secret_ciphertext
      ? await decryptSecret(sub.secret_ciphertext, env.ROUTINE_SECRET_KEY)
      : null,
  });
  if (!event) return { status: "ignored" };

  // 4. The routine's own filter, before anything is counted or spent.
  if (def.matches && !def.matches(sub.config ?? {}, event)) return { status: "filtered" };

  // 5. The fuse.
  const { perHour, perDay } = eventRunLimits(env);
  const { data: verdict, error: countError } = await db.rpc("count_routine_event", {
    p_routine_id: routine.id,
    p_per_hour: perHour,
    p_per_day: perDay,
  });
  if (countError) throw new Error(`could not count the event: ${countError.message}`);
  if (verdict === "missing") return { status: "unknown" };
  if (verdict === "hour" || verdict === "day") {
    const reason =
      verdict === "hour"
        ? `more than ${perHour} events arrived within an hour.`
        : `more than ${perDay} events arrived within a day.`;
    // Deferred, like the run: the provider is owed a quick answer, and a
    // pause that takes a mail to announce is not what it is waiting for. The
    // sync afterwards tells the provider to stop sending, which on the
    // providers that bill per event is the half that matters.
    deps.defer(
      (async () => {
        if (await pause(env, routine, reason, { db }))
          await sync(env, routine.id, { db, registry });
      })(),
    );
    return { status: "flood" };
  }

  // 6. The run, down the road every poke takes.
  const eventId = `${sub.provider}:${event.eventId}`;
  deps.defer(
    run(env, routine, {
      eventId,
      payload: event.text,
      source: "event",
      label: triggerLabel(def, event.label),
    }),
  );
  return { status: "accepted", eventId };
}
