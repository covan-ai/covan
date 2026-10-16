import type { Bindings } from "../../types";
import { serviceClient } from "../supabase";
import { runPokedRoutine } from "./dispatcher";
import type { IngestTrigger, RoutineRow, RunResult } from "./executor";
import { ROUTINE_COLUMNS } from "./ingest";
import { replyToTelegram } from "./events/telegram";

/**
 * Where a poked routine's run happens, so it finishes after the request that
 * poked it has been answered.
 *
 * A webhook sender and Composio are both owed a quick answer, so their routes
 * reply first and run the routine afterwards. On Cloudflare "afterwards" was
 * `waitUntil`, and `waitUntil` lasts thirty seconds past the response. A run
 * reads documents, calls a model and delivers, which is a minute on an
 * ordinary day. So the run was cut off after it had claimed its delivery key
 * and before it wrote its row. Nothing was delivered, nothing was recorded,
 * and the claim kept a redelivery of the same event from trying again.
 *
 * An alarm on a Durable Object is the one Cloudflare invocation nobody is
 * connected to, and it may run for fifteen minutes: the same reason a chat
 * turn runs in `TurnRoom` (`lib/turns/room.ts`). So `startPokedRun` parks the
 * trigger in an object of its own and sets an alarm for now, and the alarm
 * runs the routine.
 *
 * - **Cloudflare with `ROUTINE_ROOMS` bound**: the object, one per event
 *   (`idFromName(routine:event)`), so two events never share an alarm and a
 *   redelivery of one event lands on the object already holding it.
 * - **Anywhere else**: the run, in place. On Node the process outlives the
 *   request already. On a Cloudflare deploy without the binding the run is as
 *   long-lived as it always was, which is what a deploy that has not added the
 *   binding yet should get.
 *
 * The object is handed the routine's id, not its row. The alarm reads the row
 * again, because a routine paused or deleted between the poke and the alarm
 * should not run on the strength of a copy taken before.
 *
 * Two things happen around the run, the same on both paths. A run started by
 * a message somebody is waiting on an answer to (`trigger.replyTo`, a
 * Telegram chat) has its report sent back there once it is done
 * (`runAndAnswer`). And a caller can wait for the result (`waitMs`) — a
 * Siri shortcut reading the report out — which on the object path the object
 * holds, because only it sees the alarm finish.
 */

/** The storage key of the run `/run` parked for the alarm. */
const PENDING = "pending";

type ParkedRun = { routineId: string; trigger: IngestTrigger };

/**
 * The longest a caller may wait for the run to finish before it is answered
 * anyway — a Siri shortcut (`?wait=1` on a webhook) reading the report out.
 * Under the thirty seconds a Shortcuts "Get Contents of URL" step waits, with
 * room for the round trip.
 */
export const MAX_WAIT_MS = 25_000;

/**
 * The run, and then the conversation it came from answered, where there is
 * one (`trigger.replyTo`, a Telegram chat). The answer is after the run and
 * outside it on purpose: the executor delivers to the routine's channel
 * exactly as it always has, and a chat that cannot be reached does not make
 * a delivered run look failed.
 */
async function runAndAnswer(
  env: Bindings,
  routine: RoutineRow,
  trigger: IngestTrigger,
): Promise<RunResult> {
  const result = await runPokedRoutine(env, routine, trigger);
  if (trigger.replyTo?.provider === "telegram") {
    await replyToTelegram(env, routine.id, trigger.replyTo, result);
  }
  return result;
}

function after(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/**
 * Run the poked routine somewhere it can finish. The callers wrap this in
 * `deferred` already, so on the object path it only has to reach the object,
 * which takes milliseconds; the run itself happens in the alarm.
 *
 * A routine whose object cannot be reached runs in place instead. That
 * is the thirty seconds this file exists to get around. It is still a better
 * chance of finishing than an event dropped because a hand-off failed.
 */
/**
 * `waitMs` asks for the result if the run finishes within it — a Siri
 * shortcut waiting to read the report out. The answer is the result, or null
 * when the run is still going (or nothing was waited for); the run carries on
 * either way. On the object path the object itself holds the wait, because the
 * run is in its alarm; in place, `keepAlive` is handed the run so the caller
 * can keep it going past the response it is about to send.
 */
export async function startPokedRun(
  env: Bindings,
  routine: RoutineRow,
  trigger: IngestTrigger,
  options: { waitMs?: number; keepAlive?: (run: Promise<unknown>) => void } = {},
): Promise<RunResult | null> {
  const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), MAX_WAIT_MS);
  const ns = env.ROUTINE_ROOMS;
  if (ns) {
    try {
      const stub = ns.get(ns.idFromName(`${routine.id}:${trigger.eventId}`));
      const res = await stub.fetch(`https://routine-room/run${waitMs ? `?wait=${waitMs}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routineId: routine.id, trigger } satisfies ParkedRun),
      });
      if (res.ok) {
        if (!waitMs) return null;
        const answer = (await res.json().catch(() => null)) as { result?: RunResult | null } | null;
        return answer?.result ?? null;
      }
      console.error(`routine ${routine.id}: its room answered ${res.status}; running in place`);
    } catch (err) {
      console.error(`routine ${routine.id}: could not reach its room; running in place`, err);
    }
  }
  const running = runAndAnswer(env, routine, trigger);
  if (!waitMs) return running;
  options.keepAlive?.(running);
  return Promise.race([running, after(waitMs)]);
}

export class RoutineRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Bindings;
  /** Callers of `/run?wait=` waiting for the alarm to hand them the result. */
  private waiting: ((result: RunResult | null) => void)[] = [];

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const parked = (await request.json()) as Partial<ParkedRun>;
    if (typeof parked.routineId !== "string" || typeof parked.trigger?.eventId !== "string") {
      return Response.json({ error: "routineId and trigger are required" }, { status: 400 });
    }
    // A redelivery while the first is still parked overwrites it with the
    // same thing. One that arrives while the first is running parks a second
    // run, and that run finds the delivery key claimed and records a skip,
    // which is what a webhook delivered twice has always produced.
    const waitMs = Math.min(Number(url.searchParams.get("wait")) || 0, MAX_WAIT_MS);
    // Listening before the alarm is set, so a run that finishes at once is
    // not missed. Same isolate, same object: the alarm resolves this.
    const finished = waitMs > 0 ? this.waitFor(waitMs) : null;
    await this.state.storage.put(PENDING, parked);
    await this.state.storage.setAlarm(Date.now());
    if (!finished) return Response.json({ ok: true }, { status: 202 });
    return Response.json({ ok: true, result: await finished });
  }

  async alarm(): Promise<void> {
    const parked = await this.state.storage.get<ParkedRun>(PENDING);
    if (!parked) return;
    // Deleted before running, never after: an alarm that throws is retried,
    // and a retry that found the run still parked would run it twice. The
    // delivery claim would stop the second from delivering, but it would still
    // spend a model call to get there.
    await this.state.storage.deleteAll();

    const db = serviceClient(this.env);
    const { data, error } = await db
      .from("routines")
      .select(ROUTINE_COLUMNS)
      .eq("id", parked.routineId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) {
      console.error(`routine ${parked.routineId}: could not read it to run`, error);
      return;
    }
    const routine = data as unknown as (RoutineRow & { status: string }) | null;
    if (!routine || routine.status !== "active") return this.settle(null);

    let result: RunResult | null = null;
    try {
      result = await runAndAnswer(this.env, routine, parked.trigger);
    } catch (err) {
      // The run records its own failure on `routine_runs`, where the owner
      // looks. Not rethrown, for the reason the delete above comes first.
      console.error(`routine ${parked.routineId}: poked run failed`, err);
    }
    this.settle(result);
  }

  private settle(result: RunResult | null): void {
    for (const resolve of this.waiting.splice(0)) resolve(result);
  }

  private waitFor(ms: number): Promise<RunResult | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== settle);
        resolve(null);
      }, ms);
      const settle = (result: RunResult | null) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.waiting.push(settle);
    });
  }
}
