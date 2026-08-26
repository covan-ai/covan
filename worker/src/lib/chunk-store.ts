import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many chunk rows go in one insert.
 *
 * Each row carries a 1,536-float embedding, which serialises to roughly 12 KB
 * of JSON. 200 rows is about 2.4 MB — comfortable for a Worker, where the
 * 1,454 rows a 1 MB document produces would be ~18 MB in one body and would
 * not survive the memory limit.
 */
export const CHUNK_INSERT_BATCH = 200;

export type ChunkRow = {
  document_id: string;
  bundle_id: string;
  workspace_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
};

/**
 * Inserts chunk rows in batches, in order, stopping at the first failure.
 *
 * Returns the shape the callers already branch on (`{ error }`), so a partial
 * insert is reported exactly like a total one was before: the caller decides
 * whether that means "saved without chunks" (upload) or a 500 (reindex).
 */
export async function insertChunkRows(
  db: SupabaseClient,
  rows: ChunkRow[],
): Promise<{ error: unknown | null }> {
  for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
    const { error } = await db.from("document_chunks").insert(rows.slice(i, i + CHUNK_INSERT_BATCH));
    if (error) return { error };
  }
  return { error: null };
}
