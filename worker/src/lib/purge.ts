import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings } from "../types";
import { serviceClient } from "./supabase";
import { getDocStore, type DocStore } from "./docstore";
import { RETENTION_DAYS } from "./deletion";

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

  const keys = new Set<string>();
  const documentIds = new Set<string>();

  for (const row of await expiredDocuments(db, cutoff)) {
    documentIds.add(row.id);
    if (row.r2_key) keys.add(row.r2_key);
  }
  for (const row of await documentsInBundles(db, expiredBundleIds)) {
    if (row.r2_key) keys.add(row.r2_key);
  }

  // Agents first: the cascade takes sessions, messages, routines and
  // favourites, none of which own a stored object, so nothing here depends on
  // the key collection above.
  if (expiredAgentIds.length > 0) {
    const { error } = await db.from("agents").delete().in("id", expiredAgentIds);
    if (error) {
      console.error("purge: failed to delete expired agents", error);
    } else {
      result.agents = expiredAgentIds.length;
    }
  }

  // Bundles next, taking their documents and chunks with them.
  if (expiredBundleIds.length > 0) {
    const { error } = await db.from("knowledge_bundles").delete().in("id", expiredBundleIds);
    if (error) {
      console.error("purge: failed to delete expired bundles", error);
    } else {
      result.bundles = expiredBundleIds.length;
    }
  }

  // Then whatever is left: documents deleted on their own, whose bundle is
  // still very much alive.
  const remaining = [...documentIds];
  if (remaining.length > 0) {
    const { error } = await db.from("documents").delete().in("id", remaining);
    if (error) {
      console.error("purge: failed to delete expired documents", error);
    } else {
      result.documents = remaining.length;
    }
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

async function documentsInBundles(
  db: SupabaseClient,
  bundleIds: string[],
): Promise<{ r2_key: string | null }[]> {
  if (bundleIds.length === 0) return [];
  const { data, error } = await db.from("documents").select("r2_key").in("bundle_id", bundleIds);
  if (error) {
    console.error("purge: failed to list documents inside expiring bundles", error);
    return [];
  }
  return (data ?? []) as { r2_key: string | null }[];
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
