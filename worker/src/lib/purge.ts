import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings } from "../types";
import { serviceClient } from "./supabase";
import { getDocStore, type DocStore } from "./docstore";
import { RETENTION_DAYS } from "./deletion";
import { chunked, readAllPages } from "./batch";
import { sidecarKey } from "./document-text";

/**
 * The other half of recoverable deletion: after thirty days, the rows go for
 * real and the foreign keys do what they always did.
 *
 * It runs on the API Worker's `scheduled` handler rather than on the cron
 * Worker, and the reason is the object store. The cron Worker takes
 * `RoutineEnv`, which deliberately carries no R2 binding — nothing it does
 * touches an uploaded file. Sweeping does: a purged document's bytes have to
 * go with its row, or the erasure is not one.
 *
 * No once-a-day guard and no state to keep. On a workspace with nothing
 * expired — which is nearly every tick of nearly every workspace — this is
 * three SELECTs against partial indexes that cover only the deleted rows, and
 * they return nothing. A guard would cost more to keep honest than the queries
 * it saved.
 */

export type PurgeDeps = {
  db: SupabaseClient;
  store: DocStore | null;
  /** Overridable so a test can move the horizon without waiting thirty days. */
  horizon: Date;
};

export type PurgeResult = {
  agents: number;
  bundles: number;
  documents: number;
  objects: number;
  objectFailures: number;
};

export function defaultHorizon(now: Date = new Date()): Date {
  const at = new Date(now);
  at.setUTCDate(at.getUTCDate() - RETENTION_DAYS);
  return at;
}

/**
 * The ordering is the whole of the care here, and it is the one
 * `worker/src/routes/account.ts` has followed since account closure existed:
 * **collect the keys, delete the rows, then delete the objects.** Afterwards
 * there is nothing left to enumerate the keys by — the rows that named them are
 * gone, and an orphaned object in a bucket is invisible to everything in this
 * codebase.
 *
 * Keys are collected for two populations, not one. A document expiring on its
 * own is obvious. The other is a document sitting inside an expiring bundle:
 * it may have been deleted later than the bundle was, or not marked at all if
 * somebody restored and re-deleted around it, and the bundle's cascade will
 * take it regardless. Missing that set is how a purge quietly leaves files
 * behind forever.
 */
export async function purgeExpired(deps: PurgeDeps): Promise<PurgeResult> {
  const { db, store, horizon } = deps;
  const cutoff = horizon.toISOString();

  const result: PurgeResult = {
    agents: 0,
    bundles: 0,
    documents: 0,
    objects: 0,
    objectFailures: 0,
  };

  const expiredBundleIds = await idsOlderThan(db, "knowledge_bundles", cutoff);
  const expiredAgentIds = await idsOlderThan(db, "agents", cutoff);
  const expiredDocs = await expiredDocuments(db, cutoff);

  // In hundreds, everywhere an id list goes into a URL (`lib/batch.ts`). One
  // list of everything was a 414 past a couple of hundred rows, and the whole
  // sweep stopped for every tenant until somebody noticed.
  //
  // A bundle's documents are listed per batch of bundles, before anything is
  // deleted, and the keys are kept against that batch. A batch whose documents
  // cannot be listed is not deleted this run: deleting it would cascade the
  // rows that name its files and leave the files nobody can find. It is tried
  // again on the next tick.
  const bundleBatches: { ids: string[]; keys: string[] }[] = [];
  for (const ids of chunked(expiredBundleIds)) {
    const inside = await documentsInBundles(db, ids);
    if (inside === null) continue;
    bundleBatches.push({ ids, keys: inside.map((d) => d.r2_key).filter((k): k is string => !!k) });
  }

  // A key is deleted only once the row that named it is gone. A batch that
  // failed to delete keeps its rows, and its files with them.
  const keys = new Set<string>();

  // Agents first: the cascade takes sessions, messages, routines and
  // favourites, none of which own a stored object, so nothing here depends on
  // the key collection above.
  for (const ids of chunked(expiredAgentIds)) {
    const { error } = await db.from("agents").delete().in("id", ids);
    if (error) console.error("purge: failed to delete expired agents", error);
    else result.agents += ids.length;
  }

  // Bundles next, taking their documents and chunks with them.
  for (const batch of bundleBatches) {
    const { error } = await db.from("knowledge_bundles").delete().in("id", batch.ids);
    if (error) {
      console.error("purge: failed to delete expired bundles", error);
      continue;
    }
    result.bundles += batch.ids.length;
    for (const key of batch.keys) keys.add(key);
  }

  // Then whatever is left: documents deleted on their own, whose bundle is
  // still very much alive.
  for (const docs of chunked(expiredDocs)) {
    const { error } = await db
      .from("documents")
      .delete()
      .in(
        "id",
        docs.map((d) => d.id),
      );
    if (error) {
      console.error("purge: failed to delete expired documents", error);
      continue;
    }
    result.documents += docs.length;
    for (const d of docs) if (d.r2_key) keys.add(d.r2_key);
  }

  // Last, and best-effort. A failure here leaves a file nothing points at,
  // which is a storage cost rather than a correctness problem — and retrying it
  // is impossible anyway, because the rows that knew the key are gone. Logged
  // loudly for exactly that reason: this is the one failure in the sweep that
  // nothing downstream can repair.
  if (store) {
    for (const key of keys) {
      try {
        await store.delete(key);
        result.objects += 1;
        // The full text kept beside a PDF, when there is one. Not counted: it
        // is part of the same document, and a missing one is not a failure.
        await store.delete(sidecarKey(key)).catch(() => {});
      } catch (e) {
        result.objectFailures += 1;
        console.error("purge: failed to delete stored object", key, e);
      }
    }
  }

  return result;
}

async function idsOlderThan(db: SupabaseClient, table: string, cutoff: string): Promise<string[]> {
  const { data, error } = await db.from(table).select("id").lt("deleted_at", cutoff);
  if (error) {
    console.error(`purge: failed to list expired rows in ${table}`, error);
    return [];
  }
  return (data ?? []).map((r) => (r as { id: string }).id);
}

async function expiredDocuments(
  db: SupabaseClient,
  cutoff: string,
): Promise<{ id: string; r2_key: string | null }[]> {
  const { data, error } = await db.from("documents").select("id,r2_key").lt("deleted_at", cutoff);
  if (error) {
    console.error("purge: failed to list expired documents", error);
    return [];
  }
  return (data ?? []) as { id: string; r2_key: string | null }[];
}

/**
 * Every document inside these bundles, paged past PostgREST's thousand-row
 * cap. Null when they cannot be listed, which the caller answers by keeping
 * the bundles for another run rather than orphaning their files.
 */
async function documentsInBundles(
  db: SupabaseClient,
  bundleIds: string[],
): Promise<{ r2_key: string | null }[] | null> {
  if (bundleIds.length === 0) return [];
  const rows = await readAllPages<{ r2_key: string | null }>((from, to) =>
    db.from("documents").select("r2_key").in("bundle_id", bundleIds).order("id").range(from, to),
  );
  if (rows === null) console.error("purge: failed to list documents inside expiring bundles");
  return rows;
}

/** What the scheduled handler calls. Resolves the store, which may not exist. */
export async function runPurge(env: Bindings): Promise<PurgeResult> {
  let store: DocStore | null = null;
  try {
    store = getDocStore(env);
  } catch (e) {
    // A deployment with neither DOCS nor DOCS_DIR cannot have stored anything,
    // so there is nothing to orphan. The rows still go.
    console.error("purge: no document store configured; rows only", e);
  }

  return purgeExpired({ db: serviceClient(env), store, horizon: defaultHorizon() });
}
