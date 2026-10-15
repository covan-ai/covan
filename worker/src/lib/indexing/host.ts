import type { Bindings, SyncEnv } from "../../types";
import { serviceClient } from "../supabase";
import { advanceIndexJob, type Advance } from "./job";

/**
 * What keeps a document's indexing moving after its upload has returned.
 *
 * The same three clocks as the document engine (`lib/docs/host.ts`), and the
 * same Durable Object class: on Cloudflare `DocumentRoom` drives an index job
 * when it is kicked at `/kick-index`, one unit per alarm, so a 2,000-passage
 * document is eight alarms with their own budgets rather than one request that
 * has to fit them all. On Node this process runs the units on a timer. With
 * neither, the cron picks up whatever is due (`advanceDueIndexJobs`).
 *
 * `kickIndexJob` never throws: the document is already saved and queued, and
 * a host that cannot be reached leaves it to the cron rather than failing the
 * upload that queued it.
 */
export async function kickIndexJob(env: Bindings, documentId: string): Promise<void> {
  try {
    if (env.DOC_ROOMS) {
      const stub = env.DOC_ROOMS.get(env.DOC_ROOMS.idFromName(`index:${documentId}`));
      const res = await stub.fetch(
        `https://document-room/kick-index?document=${encodeURIComponent(documentId)}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`document room answered ${res.status}`);
      return;
    }
    if (env.PEER_ADDR !== undefined) {
      kickLocal(env, documentId);
    }
  } catch (err) {
    console.error(`index ${documentId}: could not reach its host (the cron will)`, err);
  }
}

// ---- Node ------------------------------------------------------------------

const running = new Set<string>();

function kickLocal(env: SyncEnv, documentId: string): void {
  if (running.has(documentId)) return;
  running.add(documentId);
  schedule(env, documentId, 0);
}

function schedule(env: SyncEnv, documentId: string, delayMs: number): void {
  const timer = setTimeout(() => void step(env, documentId), Math.max(0, delayMs));
  (timer as { unref?: () => void }).unref?.();
}

async function step(env: SyncEnv, documentId: string): Promise<void> {
  let next: Advance;
  try {
    next = await advanceIndexJob(serviceClient(env), env, documentId);
  } catch (err) {
    console.error(`index ${documentId}: local step failed`, err);
    next = { next: "at", at: Date.now() + 30_000 };
  }
  if (next.next === "none") {
    running.delete(documentId);
    return;
  }
  schedule(env, documentId, next.next === "now" ? 0 : next.at - Date.now());
}

/** For tests: forget the jobs this process thinks it is driving. */
export function resetLocalIndexJobs(): void {
  running.clear();
}

// ---- the cron ------------------------------------------------------------------

/**
 * Indexing nobody is driving: no Durable Object bound, a host that died
 * holding the lease, a kick that never arrived. One unit per claimed document,
 * two at most, and `true` when it claimed anything so the tick can end there.
 *
 * Skipped on a Worker with no document store — the cron-only routine engine —
 * because a unit has to read the file. The API Worker's own clocks have it.
 */
export async function advanceDueIndexJobs(env: SyncEnv, limit = 2): Promise<boolean> {
  if (!env.DOCS && !env.DOCS_DIR) return false;
  const service = serviceClient(env);
  const { data, error } = await service.rpc("claim_due_index_jobs", { p_limit: limit });
  if (error) {
    console.error("claim_due_index_jobs failed", error);
    return false;
  }
  const docs = (data ?? []) as Array<{ id: string }>;
  if (docs.length === 0) return false;

  await Promise.allSettled(
    docs.map(async (doc) => {
      // The claim took the lease; hand it to the job's own claim.
      await service.from("documents").update({ index_lease_until: null }).eq("id", doc.id);
      await advanceIndexJob(service, env, doc.id);
    }),
  );
  return true;
}
