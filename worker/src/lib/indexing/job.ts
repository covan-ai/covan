import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncEnv } from "../../types";
import { getDocStore, type DocStore } from "../docstore";
import { chunkText, embedTexts, embeddingModel, tokensSpentBefore } from "../embeddings";
import { insertChunkRows } from "../chunk-store";
import { completionSpend, embeddingSpend, entitlementsFor, spends } from "../entitlements";
import { ocrAvailable, ocrPdf, OCR_MAX_BYTES, type OcrEnv } from "../formats/read/ocr";
import { EXCERPT_LIMIT, hasIndexableText, MAX_INDEX_CHARS, extOf } from "../extract";
import { UnreadableFile } from "../formats/read";
import { readStoredText, sidecarKey, type StoredText } from "../document-text";

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
 *
 * Nor on how many files were uploaded together: a workspace indexes one
 * document at a time (0111), and the claim is where that is decided. A
 * document whose turn has not come is not claimed, and its clock is told to
 * look again in `WAIT_FOR_TURN_MS`.
 */

/**
 * Passages per unit: two embedding calls, and as many inserts as
 * `CHUNK_INSERT_BATCH` makes of them.
 */
export const UNIT = 256;

/** Units that fail in a row before the document is marked failed. */
export const MAX_ATTEMPTS = 4;

/**
 * How long a document waiting for its turn (0111) waits before it looks again.
 *
 * A workspace indexes one document at a time, so the rest of an upload of
 * several sit `queued` while the first is indexed. Nothing tells them when it
 * is done; they ask. Thirty seconds is a short gap beside the minutes a long
 * document takes, and one claim every thirty seconds per waiting document is
 * nothing beside the inserts it is waiting for.
 */
export const WAIT_FOR_TURN_MS = 30_000;

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
  if (!doc) return heldOrDone(db, documentId, now);

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
      return await begin(db, env, workspaceId, store, doc, now);
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
  env: SyncEnv,
  workspaceId: string,
  store: DocStore,
  doc: DocumentRow,
  now: () => Date,
): Promise<Advance> {
  if (!doc.r2_key) throw new Permanent("this document has no stored file to index");

  let found = await readStoredText(store, doc, MAX_INDEX_CHARS);
  // A PDF with no text of its own — a scan — is read by Claude, when this
  // deployment has a key for it. See `lib/formats/read/ocr.ts`.
  if (extOf(doc.name) === "pdf" && (!found || !hasIndexableText(found.text)) && ocrAvailable(env)) {
    found = await readByOcr(env, workspaceId, store, doc);
  }
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
        ? "no readable text in this PDF, and it could not be read as a scan either"
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

/**
 * Nothing claimed. Either a unit of this document is running (its lease is
 * held), or it is waiting for another document in its workspace to finish
 * (0111), or there is nothing left to do.
 */
async function heldOrDone(
  db: SupabaseClient,
  documentId: string,
  now: () => Date,
): Promise<Advance> {
  const { data } = await db
    .from("documents")
    .select("index_status,index_lease_until,deleted_at")
    .eq("id", documentId)
    .maybeSingle();
  const row = data as {
    index_status?: string | null;
    index_lease_until?: string | null;
    deleted_at?: string | null;
  } | null;
  if (
    !row ||
    row.deleted_at ||
    (row.index_status !== "queued" && row.index_status !== "indexing")
  ) {
    return { next: "none" };
  }
  const until = row.index_lease_until ? Date.parse(row.index_lease_until) : NaN;
  if (until > now().getTime()) return { next: "at", at: until + 1_000 };
  // Its turn has not come. Look again later rather than at once: a clock that
  // asked every second would be five waiting documents asking five times a
  // second for as long as a long one takes.
  return { next: "at", at: now().getTime() + WAIT_FOR_TURN_MS };
}

/**
 * A scanned PDF, read by Claude, and charged to its workspace.
 *
 * Refused past one request's worth (`OCR_MAX_BYTES`) rather than read in part.
 * Claude refuses past 100 pages, which arrives as an API error and is turned
 * into the same kind of answer: a document that says why it was not indexed.
 */
async function readByOcr(
  env: SyncEnv,
  workspaceId: string,
  store: DocStore,
  doc: DocumentRow,
): Promise<StoredText | null> {
  const head = await store.getRange(doc.r2_key!, 0, 0);
  if (!head) return null;
  if (head.size > OCR_MAX_BYTES) {
    throw new Permanent(
      "this PDF has no text layer and is too large to read as a scan (over 24 MB) — split it and upload the parts",
    );
  }
  const whole = await store.getRange(doc.r2_key!, 0, head.size);
  let result;
  try {
    result = await ocrPdf(env as OcrEnv, whole!.bytes);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (/100 pages|page limit|too many pages/i.test(message)) {
      throw new Permanent(
        "this PDF has no text layer and more than 100 pages, too many to read as a scan — split it and upload the parts",
      );
    }
    throw err;
  }
  const spent = spends(completionSpend(result.model, result.usage, "ocr"));
  if (spent.length > 0) {
    try {
      await entitlementsFor(env).record(workspaceId, spent, {
        userId: doc.created_by ?? undefined,
      });
    } catch (err) {
      console.error(`index ${doc.id}: could not record OCR credits`, err);
    }
  }
  if (!result.text.trim()) return null;
  return {
    text: result.text.slice(0, MAX_INDEX_CHARS),
    truncated: result.truncated || result.text.length > MAX_INDEX_CHARS,
    fromSidecar: false,
  };
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
