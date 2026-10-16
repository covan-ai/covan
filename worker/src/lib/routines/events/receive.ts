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
 *  1b. Where each subscription has its own signing secret — a GitHub webhook,
 *      a WebSub hub — the route cannot check the signature before it knows
 *      the subscription, so the adapter's `authenticate` checks it here, first.
 *   2. Anything not running is refused: a paused or binned routine, one that
 *      stopped waiting for events, a subscription that is not `active`.
 *  2b. Where a delivery only says "something changed" (a Drive channel), the
 *      adapter's `advance` lists what did from the subscription's cursor, and
 *      the cursor is moved here — the one write this file makes to the row.
 *   3. The adapter turns the raw delivery into a paragraph the model can read,
 *      or into nothing (the bot's own message coming back round).
 *   4. The entry's filter is applied. An event that does not match opens no
 *      run, writes no row and costs nothing — which is why the filter is here,
 *      ahead of everything that does.
 *   5. The flood guard counts it (0109's `count_routine_event`), and a routine
 *      over its hourly or daily limit is paused and its owner told.
 *   6. The run is deferred through `runPokedRoutine`, exactly as a webhook's
 *      is, by way of the route's `run`, which on Cloudflare moves it into a
 *      Durable Object (`../poke-room.ts`): the membership check, the credit check, claim-before-send and
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
import type { IngestTrigger, RoutineRow } from "../executor";
import { pauseForEventFlood, runPokedRoutine } from "../dispatcher";
import {
  EVENT_REGISTRY,
  type AdapterContext,
  type EventAdapter,
  type EventRegistry,
  type SubscriptionRow,
} from "./adapter";
import { triggerLabel } from "./catalog";
import { SUBSCRIPTION_COLUMNS, rememberState, syncSubscription } from "./lifecycle";

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
 *   forged    the adapter's `authenticate` refused it; the route answers 401
 *             and counts the miss, as for any bad signature
 */
export type ReceiveOutcome =
  | { status: "accepted"; eventId: string }
  | { status: "filtered" | "ignored" | "inactive" | "flood" | "unknown" | "forged" };

export type ReceiveDeps = {
  db?: SupabaseClient;
  registry?: EventRegistry;
  /** `deferred(c, …)` from the route; keeps this file free of Hono. */
  defer: (work: Promise<unknown>) => void;
  /**
   * What runs the routine. The route passes `startPokedRun`, which moves the
   * run somewhere it can outlive the response (`lib/routines/poke-room.ts`);
   * a test passes a spy to see what would have run.
   */
  run?: (env: RoutineEnv, routine: RoutineRow, trigger: IngestTrigger) => Promise<unknown>;
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

  // 1. The subscription, by whichever handle the route has. A provider's own
  // id can name more than one: Composio answers the same trigger instance to
  // two routines that asked for the same thing on the same account
  // (`composio.ts`), so a delivery is offered to each of them in turn.
  let query = db.from("routine_event_subscriptions").select(SUBSCRIPTION_COLUMNS);
  query =
    "routineId" in target
      ? query.eq("routine_id", target.routineId)
      : query.eq("provider", target.provider).eq("external_id", target.externalId);
  const { data: subRows, error: subError } = await query.limit(MAX_FAN_OUT);
  if (subError) throw new Error(`could not read the event subscription: ${subError.message}`);
  const subs = (subRows ?? []) as unknown as SubscriptionRow[];
  if (subs.length === 0) return { status: "unknown" };

  const outcomes: ReceiveOutcome[] = [];
  for (const sub of subs) {
    outcomes.push(
      await receiveFor(env, sub, raw, { db, registry, run, pause, sync, defer: deps.defer }),
    );
  }
  // What the route reports back: the most consequential of them.
  return outcomes.sort((a, b) => RANK[a.status] - RANK[b.status])[0];
}

/** Read one shared trigger's routines at most this many at a time. */
const MAX_FAN_OUT = 25;

const RANK: Record<ReceiveOutcome["status"], number> = {
  accepted: 0,
  flood: 1,
  filtered: 2,
  ignored: 3,
  inactive: 4,
  unknown: 5,
  forged: 6,
};

/** How many times a cursor someone else just moved is read again and listed from. */
const MAX_CATCH_UP = 3;

/** A `state` key an adapter may name as its cursor: it goes into a filter. */
const CURSOR_KEY = /^[A-Za-z_]{1,64}$/;

/**
 * List what changed since the subscription's cursor and move the cursor past
 * it, or hand back null when there is nothing to run on.
 *
 * The write is conditional on the cursor still being where this listing
 * started. Drive sends a notification per change, so two can arrive at once;
 * without the condition both would list the same changes and each would start
 * a run. With it the second finds the cursor moved, reads where it is now,
 * and lists only what came after — so a change made between the two listings
 * is still somebody's to report, never nobody's.
 */
async function catchUp(
  db: SupabaseClient,
  adapter: EventAdapter,
  raw: unknown,
  ctx: AdapterContext,
): Promise<unknown | null> {
  let current = ctx;
  for (let attempt = 0; attempt < MAX_CATCH_UP; attempt++) {
    const advanced = await adapter.advance!(raw, current);
    if (!advanced) return null;
    if (!CURSOR_KEY.test(advanced.cursor.key)) {
      throw new Error(`an adapter named an unusable cursor key: ${advanced.cursor.key}`);
    }
    const { data, error } = await db
      .from("routine_event_subscriptions")
      .update({ state: advanced.state })
      .eq("routine_id", current.subscription.routine_id)
      .eq(`state->>${advanced.cursor.key}`, advanced.cursor.from)
      .select("routine_id");
    if (error) throw new Error(`could not move the event cursor: ${error.message}`);
    if ((data ?? []).length > 0) return advanced.raw;

    const { data: fresh, error: freshError } = await db
      .from("routine_event_subscriptions")
      .select("state")
      .eq("routine_id", current.subscription.routine_id)
      .maybeSingle();
    if (freshError) throw new Error(`could not read the event cursor: ${freshError.message}`);
    if (!fresh) return null;
    const state = ((fresh as { state?: Record<string, unknown> | null }).state ?? {}) as Record<
      string,
      unknown
    >;
    current = { ...current, subscription: { ...current.subscription, state } };
  }
  return null;
}

/** Steps 2–6, for one subscription. */
async function receiveFor(
  env: RoutineEnv,
  sub: SubscriptionRow,
  raw: unknown,
  deps: Required<Omit<ReceiveDeps, "db" | "registry">> & {
    db: SupabaseClient;
    registry: EventRegistry;
  },
): Promise<ReceiveOutcome> {
  const { db, registry, run, pause, sync } = deps;
  const { data: routineRow, error: routineError } = await db
    .from("routines")
    .select(ROUTINE_COLUMNS)
    .eq("id", sub.routine_id)
    .maybeSingle();
  if (routineError) throw new Error(`could not read the routine: ${routineError.message}`);
  const routine = routineRow as
    (RoutineRow & { status: string; trigger_kind: string; deleted_at: string | null }) | null;
  if (!routine) return { status: "inactive" };

  const def = registry.eventType(sub.event_type);
  const adapter = registry.adapterFor(sub.provider);
  const ctx: AdapterContext | null = def
    ? {
        env,
        routine: { id: routine.id, user_id: routine.user_id, workspace_id: routine.workspace_id },
        subscription: sub,
        eventType: def,
        secret: sub.secret_ciphertext
          ? await decryptSecret(sub.secret_ciphertext, env.ROUTINE_SECRET_KEY)
          : null,
      }
    : null;

  // 1b. Is it really from them? Before the routine's state is consulted, so
  // a sender without the secret learns nothing — not even whether the
  // routine is paused — from how it is answered.
  if (adapter?.authenticate && (!ctx || !(await adapter.authenticate(raw, ctx)))) {
    return { status: "forged" };
  }

  // 2. Only a running routine waiting for exactly this.
  if (
    routine.deleted_at ||
    routine.status !== "active" ||
    routine.trigger_kind !== "event" ||
    sub.status !== "active"
  ) {
    return { status: "inactive" };
  }
  if (!ctx || !adapter || !def) return { status: "inactive" };

  // 2b. A delivery about the arrangement itself — a chat pairing with a
  // Telegram routine. Kept on the row, and nothing runs.
  const handshake = await adapter.handshake?.(raw, ctx);
  if (handshake) {
    await rememberState(db, sub.routine_id, handshake.state);
    return { status: "ignored" };
  }

  // 2c. Catch up, for a provider whose delivery only says "something changed"
  // (a Drive channel). The cursor moves here, before the filter, because it
  // has to move whether or not what changed is anything this routine wants.
  let delivered: unknown = raw;
  if (adapter.advance) {
    const caught = await catchUp(db, adapter, raw, ctx);
    if (caught === null) return { status: "ignored" };
    delivered = caught;
  }

  // 3. What happened, in a paragraph.
  const event = await adapter.normalize(delivered, ctx);
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
      ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    }),
  );
  return { status: "accepted", eventId };
}
