import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncEnv } from "../../types";
import { getDocStore, type DocStore } from "../docstore";
import { chunkText, embedTexts, embeddingModel, tokensSpentBefore } from "../embeddings";
import { insertChunkRows } from "../chunk-store";
import { embeddingSpend, entitlementsFor, spends } from "../entitlements";
import { EXCERPT_LIMIT, hasIndexableText, MAX_INDEX_CHARS, extOf } from "../extract";
import { UnreadableFile } from "../formats/read";
import { readStoredText, sidecarKey } from "../document-text";

/**
 * One document's indexing, a unit at a time.
 *
 * The upload stores the file and queues this (0105). Each call claims the
 * document's lease, does one unit and says when the next is due; whatever
 * drives it (`./host.ts`) calls again. The first unit reads the text — from
 * the sidecar a PDF's upload kept, or from the original through ranged reads —
 * writes it to the sidecar if it was not there already, and records how many
 * passages there will be. Every unit after embeds the next `UNIT` of them and
 * inserts them under the document's new generation (0103). The last one clears
 * the older generations and says `ready`, or `partial` when the text was cut at
 * `MAX_INDEX_CHARS`.
 *
 * Nothing about a unit depends on the size of the file. That is the point: the
 * upload request used to do all of this at once, and the file size was
 * whatever survived it.
 */

/** Passages per unit: two embedding calls and two inserts. */
export const UNIT = 256;

/** Units that fail in a row before the document is marked failed. */
export const MAX_ATTEMPTS = 4;

export type Advance = { next: "none" } | { next: "now" } | { next: "at"; at: number };

type DocumentRow = {
  id: string;
  name: string;
  bundle_id: string;
  r2_key: string | null;
  content: string | null;
  created_by: string | null;
  index_status: string | null;
  index_cursor: number;
  index_total: number | null;
  index_generation: number | null;
  index_attempts: number;
  index_truncated: boolean;
  index_lease_until: string | null;
};

/** A failure the document's own content caused, which no retry will fix. */
class Permanent extends Error {}

export async function advanceIndexJob(
  db: SupabaseClient,
  env: SyncEnv,
  documentId: string,
  now: () => Date = () => new Date(),
): Promise<Advance> {
  const { data: claimed, error: claimError } = await db.rpc("claim_index_job", {
    p_document_id: documentId,
  });
  if (claimError) throw new Error(`claim_index_job failed: ${claimError.message}`);
  const doc = ((claimed ?? []) as DocumentRow[])[0];
  if (!doc) return heldOrDone(db, documentId);

  const store = env.DOCS || env.DOCS_DIR ? getDocStore(env) : null;
  if (!store) {
    // The cron-only Worker has no document store. Put the lease back for a
    // Worker that does, rather than holding it for five minutes.
    await db.from("documents").update({ index_lease_until: null }).eq("id", doc.id);
    return { next: "none" };
  }

  const { data: bundle } = await db
    .from("knowledge_bundles")
    .select("workspace_id")
    .eq("id", doc.bundle_id)
    .maybeSingle();
  const workspaceId = (bundle as { workspace_id?: string } | null)?.workspace_id;
  if (!workspaceId) return fail(db, doc, "the bundle this document is in no longer exists");

  const verdict = await entitlementsFor(env).check(workspaceId);
  if (!verdict.allowed) {
    return fail(db, doc, "this workspace has no credits left — add credits and reindex it");
  }

  let tokens = 0;
  try {
    if (doc.index_status === "queued" || doc.index_total === null) {
      return await begin(db, store, doc, now);
    }

    const text = await sidecarText(store, doc);
    const header = tableHeader(doc.name, text);
    const chunks = chunkText(text);
    const from = doc.index_cursor;
    const slice = chunks.slice(from, from + UNIT);
    const generation = doc.index_generation ?? 0;

    if (slice.length > 0) {
      // What is embedded is the passage with its bearings: the document's name,
      // and for a table its header row, which only the first passage of a
      // CSV ever had. A row of numbers on its own embeds close to every other
      // row of numbers. The stored passage stays as it was — this is what it is
      // matched by, not what the model reads.
      const embedded = await embedTexts(
        env,
        slice.map((content) => withBearings(doc.name, header, content)),
      );
      tokens = embedded.tokens;
      const { error } = await insertChunkRows(
        db,
        slice.map((content, i) => ({
          document_id: doc.id,
          bundle_id: doc.bundle_id,
          workspace_id: workspaceId,
          chunk_index: from + i,
          content,
          context: doc.name,
          embedding: embedded.vectors[i],
          generation,
        })),
      );
      if (error) throw new Error(`could not save passages: ${JSON.stringify(error)}`);
    }
    await charge(env, workspaceId, doc, tokens);
    tokens = 0;

    const cursor = from + slice.length;
    if (cursor < chunks.length) {
      await db
        .from("documents")
        .update({ index_cursor: cursor, index_attempts: 0, index_lease_until: null })
        .eq("id", doc.id);
      return { next: "now" };
    }

    // Done. The new generation is complete, so the older ones go.
    const { error: clearError } = await db
      .from("document_chunks")
      .delete()
      .eq("document_id", doc.id)
      .lt("generation", generation);
    if (clearError) console.error(`index ${doc.id}: could not clear older passages`, clearError);
    await db
      .from("documents")
      .update({
        index_status: doc.index_truncated ? "partial" : "ready",
        index_cursor: cursor,
        index_attempts: 0,
        index_error: null,
        index_lease_until: null,
        index_next_run_at: null,
      })
      .eq("id", doc.id);
    return { next: "none" };
  } catch (err) {
    await charge(env, workspaceId, doc, tokens + tokensSpentBefore(err));
    if (err instanceof Permanent || err instanceof UnreadableFile) {
      return fail(db, doc, err.message);
    }
    return retry(db, doc, err, now);
  }
}

/**
 * The first unit: read the text, keep it in the sidecar, count the passages.
 *
 * Embeds nothing, so a document whose text cannot be read fails here, before
 * a credit is spent — the same order the upload route always kept.
 */
async function begin(
  db: SupabaseClient,
  store: DocStore,
  doc: DocumentRow,
  now: () => Date,
): Promise<Advance> {
  if (!doc.r2_key) throw new Permanent("this document has no stored file to index");

  const found = await readStoredText(store, doc, MAX_INDEX_CHARS);
  if (!found) {
    throw new Permanent(
      extOf(doc.name) === "pdf"
        ? "no text was kept with this PDF — upload it again so its text can be read"
        : "only the first part of this document's text was kept — upload it again",
    );
  }
  if (!hasIndexableText(found.text)) {
    throw new Permanent(
      extOf(doc.name) === "pdf"
        ? "no readable text in this PDF — it looks like a scan, so run it through OCR and upload the text"
        : "no readable text in this file — check it is really the format its name claims",
    );
  }
  if (!found.fromSidecar) {
    const encoded = new TextEncoder().encode(found.text);
    await store.put(sidecarKey(doc.r2_key), encoded.buffer as ArrayBuffer, {
      contentType: "text/plain; charset=utf-8",
    });
  }

  // One above anything the document already has. Its old passages keep
  // answering until the last unit of this run replaces them.
  const { data: newest } = await db
    .from("document_chunks")
    .select("generation")
    .eq("document_id", doc.id)
    .order("generation", { ascending: false })
    .limit(1);
  const generation = ((newest?.[0] as { generation?: number } | undefined)?.generation ?? -1) + 1;

  const { error } = await db
    .from("documents")
    .update({
      content: found.text.slice(0, EXCERPT_LIMIT),
      index_status: "indexing",
      index_total: chunkText(found.text).length,
      index_cursor: 0,
      index_generation: generation,
      index_truncated: found.truncated,
      index_attempts: 0,
      index_error: null,
      index_lease_until: null,
      index_next_run_at: now().toISOString(),
    })
    .eq("id", doc.id);
  if (error) throw new Error(`could not start indexing: ${error.message}`);
  return { next: "now" };
}

async function sidecarText(store: DocStore, doc: DocumentRow): Promise<string> {
  const obj = doc.r2_key ? await store.get(sidecarKey(doc.r2_key)) : null;
  if (!obj) {
    // Gone between units: start again rather than index nothing.
    throw new Error("the document's text went missing part-way; starting again");
  }
  return new TextDecoder().decode(await obj.arrayBuffer()).slice(0, MAX_INDEX_CHARS);
}

async function charge(
  env: SyncEnv,
  workspaceId: string,
  doc: DocumentRow,
  tokens: number,
): Promise<void> {
  const spent = spends(embeddingSpend(embeddingModel(env), tokens, "index"));
  if (spent.length === 0) return;
  try {
    await entitlementsFor(env).record(workspaceId, spent, { userId: doc.created_by ?? undefined });
  } catch (err) {
    // The embeddings are bought; a ledger that cannot be written must not turn
    // a finished unit into a failed one.
    console.error(`index ${doc.id}: could not record credits`, err);
  }
}

async function retry(
  db: SupabaseClient,
  doc: DocumentRow,
  err: unknown,
  now: () => Date,
): Promise<Advance> {
  const attempts = doc.index_attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`index ${doc.id}: unit failed (attempt ${attempts})`, err);
  if (attempts >= MAX_ATTEMPTS) return fail(db, doc, message);

  // A unit that failed half-written is simply redone: its rows are under this
  // run's generation, and the cursor only moves after a unit is in. Re-reading
  // from the start of the text on a `queued` document is the same.
  const at = now().getTime() + 30_000 * 2 ** (attempts - 1);
  if (doc.index_total !== null) {
    await db
      .from("document_chunks")
      .delete()
      .eq("document_id", doc.id)
      .eq("generation", doc.index_generation ?? 0)
      .gte("chunk_index", doc.index_cursor);
  }
  await db
    .from("documents")
    .update({
      index_attempts: attempts,
      index_error: message,
      index_lease_until: null,
      index_next_run_at: new Date(at).toISOString(),
    })
    .eq("id", doc.id);
  return { next: "at", at };
}

/** Give up: say why, and take away what this run wrote. The old passages stay. */
async function fail(db: SupabaseClient, doc: DocumentRow, reason: string): Promise<Advance> {
  if (doc.index_generation !== null && doc.index_total !== null) {
    const { count } = await db
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", doc.id)
      .lt("generation", doc.index_generation);
    // Only when there is an older set to fall back on. With none, the partial
    // set is all the document has, and some of it answering beats none of it.
    if ((count ?? 0) > 0) {
      await db
        .from("document_chunks")
        .delete()
        .eq("document_id", doc.id)
        .eq("generation", doc.index_generation);
    }
  }
  await db
    .from("documents")
    .update({
      index_status: "failed",
      index_error: reason,
      index_lease_until: null,
      index_next_run_at: null,
    })
    .eq("id", doc.id);
  return { next: "none" };
}

/** Nothing claimed: either somebody holds the lease, or there is nothing to do. */
async function heldOrDone(db: SupabaseClient, documentId: string): Promise<Advance> {
  const { data } = await db
    .from("documents")
    .select("index_status,index_lease_until")
    .eq("id", documentId)
    .maybeSingle();
  const row = data as { index_status?: string | null; index_lease_until?: string | null } | null;
  if (!row || (row.index_status !== "queued" && row.index_status !== "indexing")) {
    return { next: "none" };
  }
  const until = row.index_lease_until ? Date.parse(row.index_lease_until) : Date.now();
  return { next: "at", at: until + 1_000 };
}

/** The header row of a table-shaped document, or "" for anything else. */
export function tableHeader(name: string, text: string): string {
  const ext = extOf(name);
  if (ext !== "csv" && ext !== "tsv" && ext !== "xlsx") return "";
  // An Excel file's text opens with its first sheet's heading line.
  const lines = text.split("\n", 4).filter((l) => l.trim() && !l.startsWith("## Sheet"));
  return (lines[0] ?? "").slice(0, 300);
}

/** A passage as it is embedded: under its document's name, and its table's header. */
export function withBearings(name: string, header: string, content: string): string {
  const head = header && !content.startsWith(header) ? `${header}\n` : "";
  return `${name}\n\n${head}${content}`;
}
