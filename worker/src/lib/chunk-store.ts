import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many chunk rows go in one insert.
 *
 * Each row carries a 1,536-float embedding, which serialises to roughly 12 KB
 * of JSON, so the 1,454 rows a 1 MB document produces would be ~18 MB in one
 * body and would not survive a Worker's memory limit. That was the first
 * ceiling, and 200 rows was well under it.
 *
 * The second is the database's statement timeout. Every row is also a write
 * into the table's vector index, which costs far more than the row does, and
 * more again when the database is busy. 200 of them in one statement was fine
 * on a quiet database and ran past the timeout on a busy one — and an insert
 * that times out is redone whole, which is the same load put straight back.
 * 64 rows is a statement that stays far inside the timeout even then, and it
 * divides an indexing unit (`UNIT` in `lib/indexing/job.ts`, 256) into four
 * equal inserts.
 */
export const CHUNK_INSERT_BATCH = 64;

export type ChunkRow = {
  document_id: string;
  bundle_id: string;
  workspace_id: string;
  chunk_index: number;
  content: string;
  context: string;
  embedding: number[];
  /** Set by `replaceChunks`, never by its callers. */
  generation?: number;
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
    const { error } = await db
      .from("document_chunks")
      .insert(rows.slice(i, i + CHUNK_INSERT_BATCH));
    if (error) return { error };
  }
  return { error: null };
}

/**
 * Make `rows` a document's passages, all of them or none.
 *
 * Every writer used to delete the old passages and then insert the new ones,
 * and an insert that failed on its third batch of 200 left the document with
 * 400 of its 1,200 passages — listed as indexed, because it had chunks, and
 * answering from a third of itself with nothing anywhere saying so. A reindex
 * that failed left it with none, which is worse than the state it was asked to
 * fix.
 *
 * So the new passages go in first, under a generation number one above
 * anything the document already has (0103), and only once all of them are in
 * are the older generations deleted. A failure deletes what this call wrote and
 * leaves the old passages exactly as they were. Between the insert and the
 * delete retrieval can see both, briefly; `buildContextBlock` drops a passage
 * that repeats one already admitted, so the overlap costs nothing visible.
 *
 * Returns how many rows the document now has from this call — `rows.length`, or
 * 0 on failure — beside the error, because the upload's reply reports it.
 */
export async function replaceChunks(
  db: SupabaseClient,
  documentId: string,
  rows: ChunkRow[],
): Promise<{ error: unknown | null; count: number }> {
  const { data: newest, error: readError } = await db
    .from("document_chunks")
    .select("generation")
    .eq("document_id", documentId)
    .order("generation", { ascending: false })
    .limit(1);
  if (readError) return { error: readError, count: 0 };
  const generation = ((newest?.[0] as { generation?: number } | undefined)?.generation ?? -1) + 1;

  const { error } = await insertChunkRows(
    db,
    rows.map((r) => ({ ...r, generation })),
  );
  if (error) {
    const { error: undoError } = await db
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId)
      .eq("generation", generation);
    if (undoError)
      console.error("could not remove a partial set of passages", documentId, undoError);
    return { error, count: 0 };
  }

  const { error: clearError } = await db
    .from("document_chunks")
    .delete()
    .eq("document_id", documentId)
    .lt("generation", generation);
  // The new passages are complete and in place. Old ones left beside them are
  // duplicates retrieval already tolerates, not a reason to report failure.
  if (clearError) console.error("could not clear superseded passages", documentId, clearError);
  return { error: null, count: rows.length };
}
