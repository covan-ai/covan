import type { Bindings, RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { advanceDocumentJob, type Advance } from "./engine";

/**
 * What keeps a document job moving after the request that created it is gone.
 *
 * The engine does one unit per call (`lib/docs/engine.ts`); something has to
 * keep calling it. Three things can, and a deployment has one or more:
 *
 * - **Cloudflare with `DOC_ROOMS` bound** — a Durable Object per job. An alarm
 *   is the one Cloudflare invocation nobody is connected to, so each unit runs
 *   in its own alarm, with its own subrequest budget and wall clock, and sets
 *   the next one. A twelve-part document is fourteen alarms, not one fifteen-
 *   minute invocation that has to fit them all.
 * - **Node** (`PEER_ADDR` is how this codebase tells — see `Bindings`) — this
 *   process, with a timer, because it outlives every request already.
 * - **Neither** — no host, and nothing is lost: the open tab's poll advances
 *   the job one unit per poll (`routes/document-jobs.ts`) and the cron picks up
 *   anything nobody is watching (`advanceDueDocumentJobs` below). Slower, and
 *   correct, because every clock goes through the same lease.
 *
 * `kick` never throws. The job is already saved when it is called; a host that
 * cannot be reached leaves it to the fallback clocks rather than failing the
 * request that asked for the document.
 */
export interface DocumentHost {
  kick(jobId: string): Promise<void>;
}

export function documentHost(env: Bindings): DocumentHost | null {
  if (env.DOC_ROOMS) return durableHost(env.DOC_ROOMS);
  if (env.PEER_ADDR !== undefined) return localHost(env);
  return null;
}

/** Kicks the job if there is a host to kick, and says nothing if there is not. */
export async function kickDocumentJob(env: Bindings, jobId: string): Promise<void> {
  const host = documentHost(env);
  if (!host) return;
  try {
    await host.kick(jobId);
  } catch (err) {
    console.error(`document job ${jobId}: could not reach its host (the cron will)`, err);
  }
}

function durableHost(ns: DurableObjectNamespace): DocumentHost {
  return {
    async kick(jobId) {
      const stub = ns.get(ns.idFromName(jobId));
      const res = await stub.fetch(`https://document-room/kick?job=${encodeURIComponent(jobId)}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`document room answered ${res.status}`);
    },
  };
}

// ---- Node ------------------------------------------------------------------

/** Jobs this process is already driving, so a second kick does not start a second loop. */
const running = new Set<string>();

function localHost(env: RoutineEnv): DocumentHost {
  return {
    async kick(jobId) {
      if (running.has(jobId)) return;
      running.add(jobId);
      schedule(env, jobId, 0);
    },
  };
}

function schedule(env: RoutineEnv, jobId: string, delayMs: number): void {
  const timer = setTimeout(() => void step(env, jobId), Math.max(0, delayMs));
  // A pending section must not keep a process that is shutting down alive;
  // the cron picks the job up again after a restart.
  (timer as { unref?: () => void }).unref?.();
}

async function step(env: RoutineEnv, jobId: string): Promise<void> {
  let next: Advance;
  try {
    next = await advanceDocumentJob(serviceClient(env), env, jobId);
  } catch (err) {
    console.error(`document job ${jobId}: local step failed`, err);
    next = { next: "at", at: Date.now() + 30_000 };
  }
  if (next.next === "none") {
    running.delete(jobId);
    return;
  }
  schedule(env, jobId, next.next === "now" ? 0 : next.at - Date.now());
}

/** For tests: forget the jobs this process thinks it is driving. */
export function resetLocalDocumentJobs(): void {
  running.clear();
}

// ---- Cloudflare --------------------------------------------------------------

/** The storage key holding which job this object drives. */
const JOB = "job";

/**
 * The Durable Object that drives one document job on Cloudflare.
 *
 * Exported from `src/index.ts` for Cloudflare to find; Node never constructs
 * it. Deliberately thin: everything it knows is which job it is for, and the
 * engine's answer decides when the next alarm is.
 */
export class DocumentRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/kick" && request.method === "POST") {
      const jobId = url.searchParams.get("job");
      if (!jobId) return Response.json({ error: "job is required" }, { status: 400 });
      await this.state.storage.put(JOB, jobId);
      // Now, unless an alarm is already set: a kick during a backoff must not
      // cut the backoff short, and a kick while a unit runs finds the lease.
      const current = await this.state.storage.getAlarm();
      if (current === null) await this.state.storage.setAlarm(Date.now());
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const jobId = await this.state.storage.get<string>(JOB);
    if (!jobId) return;

    let next: Advance;
    try {
      next = await advanceDocumentJob(serviceClient(this.env), this.env, jobId);
    } catch (err) {
      // Not rethrown. A throwing alarm is retried by Cloudflare on its own
      // schedule; the engine has already recorded the attempt and its backoff,
      // so the next alarm is set here, where the backoff is known.
      console.error(`document job ${jobId}: alarm failed`, err);
      next = { next: "at", at: Date.now() + 30_000 };
    }

    if (next.next === "none") {
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.setAlarm(next.next === "now" ? Date.now() : next.at);
  }
}

// ---- the cron ------------------------------------------------------------------

/**
 * The fallback clock: jobs whose host stopped, or that never had one.
 *
 * One unit per claimed job per tick, and `true` when it claimed anything, so
 * `runScheduledWork` can end the tick there the way every other stage does.
 * The claim takes the lease itself, so the engine's own claim would find it
 * held — this hands the engine the job by clearing the lease it just took and
 * letting the engine claim it in the same breath.
 */
export async function advanceDueDocumentJobs(env: RoutineEnv, limit = 2): Promise<boolean> {
  const service = serviceClient(env);
  const { data, error } = await service.rpc("claim_due_document_jobs", { p_limit: limit });
  if (error) {
    console.error("claim_due_document_jobs failed", error);
    return false;
  }
  const jobs = (data ?? []) as Array<{ id: string }>;
  if (jobs.length === 0) return false;

  await Promise.allSettled(
    jobs.map(async (job) => {
      await service.from("document_jobs").update({ lease_until: null }).eq("id", job.id);
      await advanceDocumentJob(service, env, job.id);
    }),
  );
  return true;
}
