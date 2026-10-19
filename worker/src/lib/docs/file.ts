import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentEnv } from "../../types";
import { getDocStore } from "../docstore";
import { chunkText, embedTexts, tokensSpentBefore } from "../embeddings";
import { replaceChunks } from "../chunk-store";
import { passageIndex } from "../passages";
import { EXCERPT_LIMIT, safeName } from "../extract";

/**
 * Filing a piece of text the product wrote itself into a knowledge bundle.
 *
 * Two callers write documents nobody uploaded: a routine filing what it
 * delivered (`lib/routines/filing.ts`) and the document engine filing what it
 * wrote (`lib/docs/engine.ts`). They differ in what they are called and what
 * they do afterwards, and agree on everything here: the bundle is checked
 * against the workspace, the bytes go to the store, the row is inserted, the
 * store object is put back if the row will not go in, and the text is
 * embedded on a best-effort basis.
 *
 * SCOPING: `db` is the service-role client in both callers, so RLS is not
 * filtering any of this. The bundle is matched against the caller's trusted
 * `workspaceId`, not by id alone.
 */

export type GeneratedDocument = {
  /** Read off a trusted row — the routine's, the job's. Never a caller's. */
  workspaceId: string;
  bundleId: string;
  /** `documents.name`, as a person reads it. Not sanitised; see `lib/report.ts`. */
  name: string;
  text: string;
  /** Who the document is attributed to, where there is somebody. */
  createdBy?: string | null;
  routineId?: string | null;
  chunkSize: number;
  chunkOverlap: number;
};

export type GeneratedFiling =
  | { filed: true; documentId: string; indexTokens: number }
  | { filed: false; reason: "bundle_gone" }
  | { filed: false; reason: "failed"; note: string };

/**
 * Files one document. Throws only what the store throws on `put`; every other
 * failure comes back as a value, and the caller decides what it means.
 */
export async function fileGeneratedDocument(
  db: SupabaseClient,
  env: DocumentEnv,
  doc: GeneratedDocument,
): Promise<GeneratedFiling> {
  const { data: bundle, error: bundleError } = await db
    .from("knowledge_bundles")
    .select("id")
    .eq("id", doc.bundleId)
    .eq("workspace_id", doc.workspaceId)
    .is("deleted_at", null)
    .maybeSingle();

  if (bundleError) return { filed: false, reason: "failed", note: bundleError.message };
  if (!bundle) return { filed: false, reason: "bundle_gone" };

  const encoded = new TextEncoder().encode(doc.text);
  // `encode` allocates a fresh, exactly-sized buffer, so this is the whole
  // file rather than a view into something larger.
  const bytes = encoded.buffer as ArrayBuffer;
  const key = `${doc.bundleId}/${crypto.randomUUID()}-${safeName(doc.name)}`;

  const store = getDocStore(env);
  await store.put(key, bytes, { contentType: "text/markdown" });

  const { data: row, error: insertError } = await db
    .from("documents")
    .insert({
      bundle_id: doc.bundleId,
      name: doc.name,
      size: encoded.byteLength,
      r2_key: key,
      content: doc.text.slice(0, EXCERPT_LIMIT),
      ...(doc.routineId ? { routine_id: doc.routineId } : {}),
      ...(doc.createdBy ? { created_by: doc.createdBy } : {}),
    })
    .select("id")
    .single();

  if (insertError || !row) {
    await safeDelete(store, key);
    return { filed: false, reason: "failed", note: insertError?.message ?? "no row" };
  }

  // Past here the document exists. Embedding is best-effort on top of that,
  // for the reason the upload route gives: a document that exists and
  // retrieves nothing beats losing what was just written. It reads "Not
  // indexed" in the Knowledge tab and the reindex control is the way back.
  let indexTokens = 0;
  try {
    const chunks = chunkText(doc.text, doc.chunkSize, doc.chunkOverlap);
    if (chunks.length > 0) {
      const embedded = await embedTexts(env, chunks);
      indexTokens = embedded.tokens;
      const { error: chunkError } = await replaceChunks(
        db,
        row.id,
        chunks.map((content, index) => ({
          document_id: row.id,
          bundle_id: doc.bundleId,
          workspace_id: doc.workspaceId,
          chunk_index: index,
          content,
          context: doc.name,
          embedding: embedded.vectors[index],
        })),
        passageIndex(env),
      );
      if (chunkError) console.error("filing: could not save passages", chunkError);
    }
  } catch (err) {
    console.error("filing: embedding failed (document saved unindexed)", err);
    indexTokens = tokensSpentBefore(err);
  }

  return { filed: true, documentId: row.id, indexTokens };
}

async function safeDelete(store: ReturnType<typeof getDocStore>, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (err) {
    console.error("filing: document store rollback failed", err);
  }
}
