import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings, DocumentEnv } from "../../types";
import { getDocStore, type DocStore } from "../docstore";
import { readStoredText, storedKeysOf } from "../document-text";
import { EXCERPT_LIMIT, extOf, safeName } from "../extract";
import { UnreadableFile } from "../formats/read";
import { kickIndexJob } from "../indexing/host";
import { readableBundles, type KnowledgeScope } from "../retrieval";
import { serviceClient } from "../supabase";

/**
 * Reading and changing a document an agent can already see.
 *
 * Before this, an agent asked to fix a report it had written, or to add a line
 * to a team's checklist, had one road: `write_document`, which plans and writes
 * a new document from nothing. So "change the date in section two" produced a
 * second report beside the first, written again from the conversation, with
 * every sentence the person had liked open to being rewritten. This is the
 * other road — the text as it is stored, and an edit applied to it in place.
 *
 * WHO MAY CHANGE WHAT is decided by the database, not here. The caller's own
 * client is asked to make a no-op update of the row (`name` to itself); the
 * `documents` update policy (0106) answers with the row when this person may
 * change this document and with nothing when they may not. Only after that
 * answer does the service role write the columns no client is granted
 * (`r2_key`, `size`, `content` — 0085), keyed to that row id and to the stored
 * key it was read at, so an edit that raced another lands on nothing rather
 * than over it. That is the shape `routes/document-jobs.ts` has: read through
 * the caller, then write by the id the read returned.
 *
 * WHAT CAN BE CHANGED IN PLACE is a document whose stored file IS its text —
 * Markdown, plain text, CSV, JSON, HTML, XML. A Word file or a PDF is not: its
 * text is extracted from a container this code cannot write back into, and
 * writing Markdown over a `.docx` would hand the next download a broken file.
 * Those, and documents synced from Notion or Drive (whose next sync would put
 * the source back over the edit), get an edited Markdown copy beside them
 * instead, and the original is left exactly as it was.
 */

/** Extensions whose stored bytes are the document's text. */
export const EDITABLE_IN_PLACE = new Set([
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "json",
  "html",
  "htm",
  "xml",
]);

/**
 * The longest text an edit will work on. Past this the agent cannot have read
 * the whole of it in one turn, and an edit applied to the part it read would
 * be written back without the rest.
 */
export const MAX_EDITABLE_CHARS = 400_000;

/** What one `read_document` call returns at most. */
export const READ_PAGE_CHARS = 30_000;

export type FoundDocument = {
  id: string;
  name: string;
  bundle_id: string;
  bundle_name: string | null;
  workspace_id: string;
  r2_key: string | null;
  content: string | null;
  size: number | null;
  connection_id: string | null;
  index_status: string | null;
  index_lease_until: string | null;
  created_at: string | null;
};

const DOC_COLUMNS =
  "id,name,bundle_id,r2_key,content,size,connection_id,index_status,index_lease_until,created_at," +
  "knowledge_bundles(name,workspace_id)";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Omit<FoundDocument, "bundle_name" | "workspace_id"> & {
  knowledge_bundles?:
    | { name?: string | null; workspace_id?: string | null }
    | Array<{ name?: string | null; workspace_id?: string | null }>
    | null;
};

function toFound(row: Row): FoundDocument {
  const bundle = Array.isArray(row.knowledge_bundles)
    ? row.knowledge_bundles[0]
    : row.knowledge_bundles;
  const { knowledge_bundles: _bundle, ...rest } = row;
  return {
    ...rest,
    bundle_name: bundle?.name ?? null,
    workspace_id: bundle?.workspace_id ?? "",
  };
}

/** Who is asking, as far as finding a document goes. */
export type DocumentAsker = {
  db: SupabaseClient;
  agentId: string;
  workspaceId: string;
  knowledgeScope?: KnowledgeScope;
};

/**
 * The bundles this agent reads in this conversation: attached to it, and — in
 * a shared conversation — shared. The same narrowing retrieval applies, so an
 * agent can open exactly the documents it could have quoted.
 */
export async function bundlesFor(asker: DocumentAsker): Promise<string[]> {
  const { data, error } = await asker.db
    .from("agent_bundles")
    .select("bundle_id")
    .eq("agent_id", asker.agentId);
  if (error) return [];
  const attached = ((data ?? []) as Array<{ bundle_id: string }>).map((r) => r.bundle_id);
  return readableBundles(asker.db, attached, asker.knowledgeScope ?? {});
}

/** The documents this agent can see, newest first, optionally narrowed by name. */
export async function listAgentDocuments(
  asker: DocumentAsker,
  query: string | null,
  limit: number,
): Promise<FoundDocument[]> {
  const bundles = await bundlesFor(asker);
  if (bundles.length === 0) return [];
  let q = asker.db
    .from("documents")
    .select(DOC_COLUMNS)
    .in("bundle_id", bundles)
    .is("deleted_at", null);
  if (query && query.trim()) q = q.ilike("name", `%${escapeLike(query.trim())}%`);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`list documents: ${error.message}`);
  return ((data ?? []) as unknown as Row[])
    .map(toFound)
    .filter((d) => !d.workspace_id || d.workspace_id === asker.workspaceId);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type Lookup =
  | { kind: "found"; doc: FoundDocument }
  | { kind: "none"; message: string }
  | { kind: "ambiguous"; message: string };

/**
 * One document, by id or by name, among those this agent can see.
 *
 * By id first, because that is what the list and the conversation's document
 * note hand the model. By name as a courtesy — "the onboarding checklist" is
 * what the person typed — exact before partial, and more than one match is
 * named back rather than guessed between.
 */
export async function findAgentDocument(asker: DocumentAsker, ref: string): Promise<Lookup> {
  const wanted = ref.trim();
  if (!wanted) return { kind: "none", message: "document is required: an id or a name" };
  const bundles = await bundlesFor(asker);
  if (bundles.length === 0) {
    return { kind: "none", message: "no documents are attached to this agent here" };
  }

  if (UUID.test(wanted)) {
    const { data, error } = await asker.db
      .from("documents")
      .select(DOC_COLUMNS)
      .eq("id", wanted)
      .in("bundle_id", bundles)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(`load document: ${error.message}`);
    if (data) {
      const doc = toFound(data as unknown as Row);
      if (!doc.workspace_id || doc.workspace_id === asker.workspaceId) {
        return { kind: "found", doc };
      }
    }
    return {
      kind: "none",
      message:
        "no document with that id is among the ones this agent can read here. " +
        "Call list_documents to see them.",
    };
  }

  const candidates = await listAgentDocuments(asker, wanted, 10);
  const exact = candidates.filter((d) => d.name.toLowerCase() === wanted.toLowerCase());
  const pool = exact.length > 0 ? exact : candidates;
  if (pool.length === 1) return { kind: "found", doc: pool[0] };
  if (pool.length === 0) {
    return {
      kind: "none",
      message: `no document named like "${wanted}". Call list_documents to see the ones you can read.`,
    };
  }
  return {
    kind: "ambiguous",
    message:
      `more than one document matches "${wanted}"; call again with one of these ids:\n` +
      pool.map((d) => `- ${d.name} (id: ${d.id})`).join("\n"),
  };
}

/** Whether this document's stored file is its text, and is not owned by a sync. */
export function editableInPlace(doc: Pick<FoundDocument, "name" | "connection_id">): boolean {
  return EDITABLE_IN_PLACE.has(extOf(doc.name)) && !doc.connection_id;
}

export type ReadResult =
  { kind: "ok"; text: string; truncated: boolean } | { kind: "error"; message: string };

/** A document's text, at most `maxChars` of it. */
export async function readDocumentText(
  env: DocumentEnv,
  doc: FoundDocument,
  maxChars: number,
): Promise<ReadResult> {
  let store: DocStore | null;
  try {
    store = getDocStore(env);
  } catch {
    store = null;
  }
  try {
    const found = await readStoredText(store, doc, maxChars);
    if (!found) {
      return {
        kind: "error",
        message:
          "only a short excerpt of this document's text was kept, so it cannot be read whole",
      };
    }
    return { kind: "ok", text: found.text, truncated: found.truncated };
  } catch (err) {
    if (err instanceof UnreadableFile) return { kind: "error", message: err.message };
    throw err;
  }
}

export type Edit = { find: string; replace: string; all?: boolean };

export type Applied =
  { kind: "ok"; text: string; changed: number } | { kind: "error"; message: string };

/**
 * Exact-text edits, applied in order, each to the result of the one before.
 *
 * Exact rather than fuzzy on purpose: an edit that matches somewhere the model
 * did not mean is a silent change to somebody's document. A `find` that
 * matches nothing, or matches more than once without `all`, refuses the whole
 * set — nothing half-applied — and says how many times it matched, which is
 * what the model needs to send a longer, unique `find`.
 */
export function applyEdits(text: string, edits: Edit[]): Applied {
  let out = text;
  let changed = 0;
  for (const [i, edit] of edits.entries()) {
    const label = edits.length > 1 ? `edit ${i + 1}: ` : "";
    if (!edit.find) return { kind: "error", message: `${label}find must not be empty` };
    const count = occurrences(out, edit.find);
    if (count === 0) {
      return {
        kind: "error",
        message:
          `${label}the text to find does not appear in the document. Copy it exactly from ` +
          "read_document, including punctuation and line breaks. Nothing was changed.",
      };
    }
    if (count > 1 && !edit.all) {
      return {
        kind: "error",
        message:
          `${label}the text to find appears ${count} times. Include more of the surrounding ` +
          "text so it is unique, or set all to true to change every one. Nothing was changed.",
      };
    }
    out = edit.all
      ? out.split(edit.find).join(edit.replace)
      : replaceOnce(out, edit.find, edit.replace);
    changed += edit.all ? count : 1;
  }
  return { kind: "ok", text: out, changed };
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count++;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function replaceOnce(text: string, find: string, replace: string): string {
  const at = text.indexOf(find);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

export type Saved =
  | { kind: "replaced"; documentId: string; name: string }
  | { kind: "copied"; documentId: string; name: string }
  | { kind: "error"; message: string };

/**
 * Writes `text` over the document, or — when it cannot be changed in place —
 * beside it as an edited Markdown copy. Either way the result is queued for
 * indexing, so its passages follow the words.
 */
export async function saveDocumentText(
  asker: DocumentAsker & { env: DocumentEnv },
  doc: FoundDocument,
  text: string,
): Promise<Saved> {
  if (editableInPlace(doc) && doc.r2_key) return replaceInPlace(asker, doc, text);
  return saveCopy(asker, doc, text);
}

async function replaceInPlace(
  asker: DocumentAsker & { env: DocumentEnv },
  doc: FoundDocument,
  text: string,
): Promise<Saved> {
  // The database's answer to "may this person change this document".
  const { data: allowed, error: probeError } = await asker.db
    .from("documents")
    .update({ name: doc.name })
    .eq("id", doc.id)
    .select("id")
    .maybeSingle();
  if (probeError || !allowed) {
    return {
      kind: "error",
      message:
        "the person you are working for cannot change this document (it is in a bundle " +
        "they cannot write to). Say so; offer the change as text instead.",
    };
  }
  if (doc.index_lease_until && Date.parse(doc.index_lease_until) > Date.now()) {
    return {
      kind: "error",
      message:
        "this document is being indexed at this moment. Nothing was changed; try the same " +
        "edit again in a minute.",
    };
  }

  const store = getDocStore(asker.env);
  const encoded = new TextEncoder().encode(text);
  const key = `${doc.bundle_id}/${crypto.randomUUID()}-${safeName(doc.name)}`;
  await store.put(key, encoded.buffer as ArrayBuffer, { contentType: storedTypeOf(doc.name) });

  const service = serviceClient(asker.env);
  const { data: updated, error } = await service
    .from("documents")
    .update({
      r2_key: key,
      size: encoded.byteLength,
      content: text.slice(0, EXCERPT_LIMIT),
      index_status: "queued",
      index_cursor: 0,
      index_total: null,
      index_attempts: 0,
      index_error: null,
      index_truncated: false,
      index_next_run_at: new Date().toISOString(),
    })
    .eq("id", allowed.id as string)
    .eq("bundle_id", doc.bundle_id)
    .eq("r2_key", doc.r2_key as string)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error || !updated) {
    await deleteKeys(store, [key]);
    return {
      kind: "error",
      message: error
        ? `the document could not be saved: ${error.message}`
        : "the document changed while this edit was being made. Read it again and redo the edit.",
    };
  }

  // The old file and its extracted text are now nobody's.
  await deleteKeys(store, storedKeysOf(doc.r2_key as string));
  await kickIndexJob(asker.env as unknown as Bindings, doc.id);
  await refreshWrittenSections(service, doc, text);
  return { kind: "replaced", documentId: doc.id, name: doc.name };
}

async function saveCopy(
  asker: DocumentAsker & { env: DocumentEnv },
  doc: FoundDocument,
  text: string,
): Promise<Saved> {
  const name = copyName(doc.name);
  const store = getDocStore(asker.env);
  const encoded = new TextEncoder().encode(text);
  const key = `${doc.bundle_id}/${crypto.randomUUID()}-${safeName(name)}`;
  await store.put(key, encoded.buffer as ArrayBuffer, { contentType: "text/markdown" });

  // The caller's own client: the insert policy decides whether they may add
  // to this bundle, exactly as it does for an upload.
  const { data: row, error } = await asker.db
    .from("documents")
    .insert({
      bundle_id: doc.bundle_id,
      name,
      size: encoded.byteLength,
      r2_key: key,
      content: text.slice(0, EXCERPT_LIMIT),
      index_status: "queued",
    })
    .select("id")
    .single();
  if (error || !row) {
    await deleteKeys(store, [key]);
    return {
      kind: "error",
      message:
        "the edited copy could not be saved — the person you are working for may not be " +
        "able to add documents to that bundle. Offer the change as text instead.",
    };
  }
  await kickIndexJob(asker.env as unknown as Bindings, row.id as string);
  return { kind: "copied", documentId: row.id as string, name };
}

/** "Contract.docx" → "Contract (edited).md". */
export function copyName(name: string): string {
  const ext = extOf(name);
  const base =
    ext && name.toLowerCase().endsWith(`.${ext}`) ? name.slice(0, -(ext.length + 1)) : name;
  return `${base} (edited).md`;
}

function storedTypeOf(name: string): string {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (ext === "tsv") return "text/tab-separated-values";
  return "text/plain; charset=utf-8";
}

async function deleteKeys(store: DocStore, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (err) {
      console.error("document edit: could not delete a stored object", err);
    }
  }
}

/**
 * A document the engine wrote is shown in its conversation from the job's
 * sections, not from the file (`document-panel.tsx`). Without this, the card
 * would go on showing the words the edit replaced while the download carried
 * the new ones. Best-effort: the file is the document, and a panel a step
 * behind is a smaller failure than an edit refused after it was saved.
 */
async function refreshWrittenSections(
  service: SupabaseClient,
  doc: FoundDocument,
  text: string,
): Promise<void> {
  try {
    const { data: jobs, error } = await service
      .from("document_jobs")
      .select("id,title")
      .eq("document_id", doc.id)
      .eq("workspace_id", doc.workspace_id)
      .eq("status", "ready");
    if (error || !jobs || jobs.length === 0) return;
    const { title, sections } = splitWritten(text);
    for (const job of jobs as Array<{ id: string; title: string }>) {
      const { error: dropError } = await service
        .from("document_sections")
        .delete()
        .eq("job_id", job.id);
      if (dropError) throw dropError;
      if (sections.length > 0) {
        const { error: insertError } = await service.from("document_sections").insert(
          sections.map((s, idx) => ({
            job_id: job.id,
            idx,
            heading: s.heading || title || job.title,
            brief: "",
            body: s.body,
            status: "done",
          })),
        );
        if (insertError) throw insertError;
      }
      await service
        .from("document_jobs")
        .update({
          title: title || job.title,
          outline: sections.map((s) => ({ heading: s.heading || title || job.title, brief: "" })),
          cursor: sections.length,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }
  } catch (err) {
    console.error(`document edit: could not refresh the sections of ${doc.id}`, err);
  }
}

/**
 * The inverse of `assembleDocument` (`outline.ts`): a `# ` title on the first
 * line, then `## ` parts. Text before the first part, if any, becomes a part
 * of its own so nothing is dropped.
 */
export function splitWritten(text: string): {
  title: string;
  sections: Array<{ heading: string; body: string }>;
} {
  let rest = text.replace(/\r\n/g, "\n");
  let title = "";
  const head = rest.match(/^\s*#[ \t]+([^\n]+)\n?/);
  if (head) {
    title = head[1].trim();
    rest = rest.slice(head[0].length);
  }
  const sections: Array<{ heading: string; body: string }> = [];
  const parts = rest.split(/^##[ \t]+/m);
  const lead = parts.shift() ?? "";
  if (lead.trim()) sections.push({ heading: "", body: lead.trim() });
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const body = newline === -1 ? "" : part.slice(newline + 1).trim();
    sections.push({ heading, body });
  }
  return { title, sections };
}
