import type { Bindings } from "../../types";
import { serviceClient } from "../supabase";
import { runPokedRoutine } from "./dispatcher";
import type { IngestTrigger, RoutineRow } from "./executor";
import { ROUTINE_COLUMNS } from "./ingest";

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
 */

/** The storage key of the run `/run` parked for the alarm. */
const PENDING = "pending";

type ParkedRun = { routineId: string; trigger: IngestTrigger };

/**
 * Run the poked routine somewhere it can finish. The callers wrap this in
 * `deferred` already, so on the object path it only has to reach the object,
 * which takes milliseconds; the run itself happens in the alarm.
 *
 * A routine whose object cannot be reached runs in place instead. That
 * is the thirty seconds this file exists to get around. It is still a better
 * chance of finishing than an event dropped because a hand-off failed.
 */
export async function startPokedRun(
  env: Bindings,
  routine: RoutineRow,
  trigger: IngestTrigger,
): Promise<void> {
  const ns = env.ROUTINE_ROOMS;
  if (ns) {
    try {
      const stub = ns.get(ns.idFromName(`${routine.id}:${trigger.eventId}`));
      const res = await stub.fetch("https://routine-room/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routineId: routine.id, trigger } satisfies ParkedRun),
      });
      if (res.ok) return;
      console.error(`routine ${routine.id}: its room answered ${res.status}; running in place`);
    } catch (err) {
      console.error(`routine ${routine.id}: could not reach its room; running in place`, err);
    }
  }
  await runPokedRoutine(env, routine, trigger);
}

export class RoutineRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Bindings;

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
    await this.state.storage.put(PENDING, parked);
    await this.state.storage.setAlarm(Date.now());
    return Response.json({ ok: true }, { status: 202 });
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
    if (!routine || routine.status !== "active") return;

    try {
      await runPokedRoutine(this.env, routine, parked.trigger);
    } catch (err) {
      // The run records its own failure on `routine_runs`, where the owner
      // looks. Not rethrown, for the reason the delete above comes first.
      console.error(`routine ${parked.routineId}: poked run failed`, err);
    }
  }
}
