import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../types";
import { serviceClient } from "./supabase";

/**
 * Where passage embeddings live when they do not live in Postgres.
 *
 * Bound as `PASSAGES` — a Cloudflare Vectorize index of 1,536 dimensions,
 * cosine, with a string metadata index on `bundle_id` — a deployment keeps its
 * embeddings there and `document_chunks.embedding` null. Unbound, which is
 * every Node deployment and the default on Cloudflare, nothing here runs and
 * the column is the index, as it always was. 0116 says why the split exists:
 * the vectors were most of the database.
 *
 * What does not move is the authority. The index is asked "which passages are
 * nearest", and the ids it answers go back to Postgres
 * (`match_passages_ranked`), which reads them under the caller's policies and
 * drops any it would not have shown. A stale vector — a passage deleted since,
 * a bundle unshared since — costs a slot in the shortlist, never a leak.
 */
export type PassageIndex = Vectorize;

export type PassageEnv = { PASSAGES?: Vectorize };

export function passageIndex(env: PassageEnv): PassageIndex | null {
  return env.PASSAGES ?? null;
}

export type PassageVector = {
  id: string;
  workspaceId: string;
  bundleId: string;
  documentId: string;
  values: number[];
};

/** Vectorize takes up to 1,000 vectors in one write from a Worker. */
const WRITE_BATCH = 1000;

/**
 * Bundle ids per query. A metadata filter is capped at 2 KB of JSON, and an id
 * is 39 bytes of it with its quotes and comma; 40 leaves room for the rest.
 */
const BUNDLES_PER_QUERY = 40;

/** `getByIds` answers twenty at a time. */
const READ_BATCH = 20;

export async function putPassages(index: PassageIndex, vectors: PassageVector[]): Promise<void> {
  for (let i = 0; i < vectors.length; i += WRITE_BATCH) {
    await index.upsert(
      vectors.slice(i, i + WRITE_BATCH).map((v) => ({
        id: v.id,
        values: v.values,
        metadata: { bundle_id: v.bundleId, document_id: v.documentId, workspace_id: v.workspaceId },
      })),
    );
  }
}

/**
 * The `topK` passages nearest `values`, among `bundleIds`, best first.
 *
 * Similarity is cosine, the same number `1 - (a <=> b)` is in `match_chunks`,
 * so `RAG_MIN_SIMILARITY` means the same thing either side.
 */
export async function nearestPassages(
  index: PassageIndex,
  values: number[],
  bundleIds: string[],
  topK: number,
): Promise<Array<{ id: string; similarity: number }>> {
  if (bundleIds.length === 0) return [];
  const groups: string[][] = [];
  for (let i = 0; i < bundleIds.length; i += BUNDLES_PER_QUERY) {
    groups.push(bundleIds.slice(i, i + BUNDLES_PER_QUERY));
  }
  const answers = await Promise.all(
    groups.map((group) =>
      index.query(values, {
        topK,
        returnValues: false,
        returnMetadata: "none",
        filter: { bundle_id: group.length === 1 ? group[0] : { $in: group } },
      }),
    ),
  );
  return answers
    .flatMap((a) => a.matches)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((m) => ({ id: m.id, similarity: m.score }));
}

/** Changes read per tick, and passages moved out of the column per page. */
const CHANGES_PER_TICK = 500;
const INLINE_PAGE = 100;
const INLINE_PAGES_PER_TICK = 10;

type Change = {
  id: number;
  chunk_id: string;
  bundle_id: string | null;
  document_id: string | null;
};

/**
 * Keep the index in step with `document_chunks`, from the background tick.
 *
 * Two jobs, both idle at one query when there is nothing to do:
 *
 * 1. **What 0116's trigger wrote down.** A passage deleted is deleted from the
 *    index. A passage moved to another bundle is written again under its new
 *    bundle, with the values the index already holds — there is no copy of
 *    them anywhere else.
 * 2. **Embeddings still in the column.** Everything written before the index
 *    was bound, and anything a writer put there since, is copied to the index
 *    and then cleared from the row. This is the whole migration: bind the
 *    index, and the column empties itself a page at a time.
 *
 * Returns whether it did anything, for `runScheduledWork`'s either/or.
 */
export async function syncPassageVectors(env: RoutineEnv & PassageEnv): Promise<boolean> {
  const index = passageIndex(env);
  if (!index) return false;
  const service = serviceClient(env);
  // Each half on its own: an index that is down must not stop the stages
  // after this one, and what was not done is still there next tick.
  const told = await applyChanges(service, index).catch((err) => {
    console.error("passages: could not tell the index what changed", err);
    return 0;
  });
  const moved = await moveInlineEmbeddings(service, index).catch((err) => {
    console.error("passages: could not move embeddings into the index", err);
    return 0;
  });
  return told + moved > 0;
}

async function applyChanges(service: SupabaseClient, index: PassageIndex): Promise<number> {
  const { data, error } = await service
    .from("passage_vector_changes")
    .select("id,chunk_id,bundle_id,document_id")
    .order("id", { ascending: true })
    .limit(CHANGES_PER_TICK);
  if (error) {
    console.error("passages: could not read the changes", error);
    return 0;
  }
  const changes = (data ?? []) as Change[];
  if (changes.length === 0) return 0;

  // The last word on each passage is the one that counts: moved and then
  // deleted is deleted.
  const latest = new Map<string, Change>();
  for (const change of changes) latest.set(change.chunk_id, change);
  const gone = [...latest.values()].filter((c) => c.bundle_id === null).map((c) => c.chunk_id);
  const rehomed = [...latest.values()].filter((c) => c.bundle_id !== null);

  if (gone.length > 0) await index.deleteByIds(gone);
  for (let i = 0; i < rehomed.length; i += READ_BATCH) {
    const batch = rehomed.slice(i, i + READ_BATCH);
    const held = await index.getByIds(batch.map((c) => c.chunk_id));
    const byId = new Map(batch.map((c) => [c.chunk_id, c]));
    const again = held.flatMap((v) => {
      const change = byId.get(v.id);
      if (!change) return [];
      const metadata = (v.metadata ?? {}) as Record<string, unknown>;
      return [
        {
          id: v.id,
          values: Array.from(v.values),
          metadata: {
            ...metadata,
            bundle_id: change.bundle_id as string,
            ...(change.document_id ? { document_id: change.document_id } : {}),
          },
        },
      ];
    });
    if (again.length > 0) await index.upsert(again);
  }

  const last = changes[changes.length - 1].id;
  const { error: clearError } = await service
    .from("passage_vector_changes")
    .delete()
    .lte("id", last);
  if (clearError) console.error("passages: could not clear the changes told", clearError);
  return changes.length;
}

async function moveInlineEmbeddings(service: SupabaseClient, index: PassageIndex): Promise<number> {
  let moved = 0;
  for (let page = 0; page < INLINE_PAGES_PER_TICK; page++) {
    const { data, error } = await service
      .from("document_chunks")
      .select("id,workspace_id,bundle_id,document_id,embedding")
      .not("embedding", "is", null)
      .limit(INLINE_PAGE);
    if (error) {
      console.error("passages: could not read embeddings still in the column", error);
      break;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      workspace_id: string;
      bundle_id: string;
      document_id: string;
      embedding: string | number[];
    }>;
    if (rows.length === 0) break;

    await putPassages(
      index,
      rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        bundleId: r.bundle_id,
        documentId: r.document_id,
        // PostgREST sends a vector as its text form, "[0.1,0.2,…]".
        values:
          typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : r.embedding,
      })),
    );
    const { error: clearError } = await service
      .from("document_chunks")
      .update({ embedding: null })
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (clearError) {
      // Written to the index and still in the column: the next tick writes it
      // again, which an upsert makes harmless.
      console.error("passages: could not clear embeddings now in the index", clearError);
      break;
    }
    moved += rows.length;
    if (rows.length < INLINE_PAGE) break;
  }
  return moved;
}
