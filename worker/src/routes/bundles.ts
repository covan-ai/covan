import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapBundle, mapDocument } from "../lib/dto";
import { callerWorkspaceId } from "../lib/workspace";
import { chunkText, embedTexts, embeddingModel, tokensSpentBefore } from "../lib/embeddings";
import {
  ALLOWED_EXT,
  contentTypeFor,
  EXCERPT_LIMIT,
  hasIndexableText,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_INDEX_CHARS,
  noTextMessage,
  safeName,
} from "../lib/extract";
import { getDocStore } from "../lib/docstore";
import { guardCredits } from "../lib/entitlements/guard";
import { replaceChunks } from "../lib/chunk-store";
import { passageIndex } from "../lib/passages";
import { uploadLimit } from "../lib/body-limit";
import { readStoredText, sidecarKey, storedKeysOf } from "../lib/document-text";
import { extractFromBytes, UnreadableFile } from "../lib/formats/read";
import { deferred } from "../lib/defer";
import { ocrAvailable, OCR_MAX_BYTES } from "../lib/formats/read/ocr";
import { decodeEntities, htmlToText } from "../lib/formats/read/text";
import { fetchSource } from "../lib/routines/source";
import { ownHostsFrom } from "../lib/routines/url-guard";
import { kickIndexJob } from "../lib/indexing/host";
import { callDeletionFn } from "../lib/deletion";

const bundles = new Hono<AppEnv>();

const BUNDLE_SELECT = "id,name,description,created_at,scope,created_by,documents(count)";

// Everything a row in the Knowledge explorer renders. `connection_id` and
// `external_url` are here because a synced document is not freely movable —
// the interface has to be able to say so before somebody drags one.
// `routines(name)` is embedded through `documents.routine_id` and resolves
// through `routines`' own RLS rather than through the document's: a colleague's
// private routine filing into a shared bundle comes back as a null name beside
// a real id, which is exactly what the explorer should say about it. See
// `DocumentDTO.routineName`.
//
// One string literal, not a concatenation — postgrest-js infers the row type
// from the literal, and `"a," + "b"` widens it to `string`.
// prettier-ignore
const DOCUMENT_SELECT =
  "id,name,size,created_at,bundle_id,connection_id,external_url,routine_id,routines(name),document_chunks(count),index_status,index_cursor,index_total,index_error";

/** The explorer's listing also says who put each file there. */
const LISTING_SELECT =
  "id,name,size,created_at,created_by,bundle_id,connection_id,external_url,routine_id,routines(name),document_chunks(count),index_status,index_cursor,index_total,index_error";

/** What an upload returns about the document it just made. */
export const UPLOADED_SELECT =
  "id,name,size,created_at,bundle_id,index_status,index_cursor,index_total,index_error";

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Shared with the workspace from the start. Private when absent (0106). */
  shared: z.boolean().optional(),
});
const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    /** Share it with the workspace, or take it back. Its maker's alone to do. */
    shared: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field required" });

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
// Constant-time string comparison so the admin-key check can't be timing-probed.
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// GET /bundles
bundles.get("/bundles", async (c) => {
  const db = c.get("db");

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json([]);

  const { data, error } = await db
    .from("knowledge_bundles")
    .select(BUNDLE_SELECT)
    .eq("workspace_id", workspaceId)
    .order("created_at");
  if (error) return c.json({ error: "failed to load bundles" }, 500);
  const viewer = c.get("user").id;
  return c.json((data ?? []).map((row) => mapBundle(row, viewer)));
});

// GET /knowledge/usage — how much of the workspace's knowledge the caller can
// see: bundles, files, bytes and passages. Counted by the caller's own
// policies (0107's `knowledge_usage` is an invoker), so a colleague's private
// bundles are in nobody else's numbers.
bundles.get("/knowledge/usage", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ bundles: 0, documents: 0, bytes: 0, passages: 0 });
  const { data, error } = await c
    .get("db")
    .rpc("knowledge_usage", { p_workspace_id: workspaceId })
    .maybeSingle();
  if (error) return c.json({ error: "failed to count" }, 500);
  const row = (data ?? {}) as Partial<
    Record<"bundles" | "documents" | "bytes" | "passages", number>
  >;
  return c.json({
    bundles: Number(row.bundles ?? 0),
    documents: Number(row.documents ?? 0),
    bytes: Number(row.bytes ?? 0),
    passages: Number(row.passages ?? 0),
  });
});

// GET /bundles/citations — how many answers cite each document, workspace-wide.
//
// Two calls rather than one because they answer two different questions, and
// the second one is the caveat on the first: `since` is the oldest reply that
// could be counted at all. Replies written before ids were stored cite by name
// alone (#54), so every number here is over a window and the interface has to
// be able to say which. Sending the counts without it would print a census and
// mean a sample.
//
// Both are RPCs into `security definer` functions because the count has to
// cross private sessions — see 0038. What comes back is a number per document
// and a timestamp; who asked and what they asked stay where they are.
bundles.get("/bundles/citations", async (c) => {
  const db = c.get("db");

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ since: null, counts: {} });

  const { data: bundleRows, error: bundleError } = await db
    .from("knowledge_bundles")
    .select("id")
    .eq("workspace_id", workspaceId);
  if (bundleError) return c.json({ error: "failed to load bundles" }, 500);

  const bundleIds = (bundleRows ?? []).map((b) => b.id as string);
  if (bundleIds.length === 0) return c.json({ since: null, counts: {} });

  const [counted, sinceResult] = await Promise.all([
    db.rpc("document_citation_counts", { p_bundle_ids: bundleIds }),
    db.rpc("citations_counted_since", { p_workspace_id: workspaceId }),
  ]);

  if (counted.error || sinceResult.error) {
    return c.json({ error: "failed to count citations" }, 500);
  }

  const counts: Record<string, number> = {};
  for (const row of (counted.data ?? []) as Array<{ document_id: string; citations: number }>) {
    // Postgres counts are bigint, which PostgREST sends as a JSON number here
    // and as a string once it exceeds 2^53. Coerced rather than trusted: a
    // string would sort as text, and "9" would outrank "41".
    counts[row.document_id] = Number(row.citations);
  }

  const since = (sinceResult.data as string | null) ?? null;
  return c.json({ since: since ? Date.parse(since) : null, counts });
});

// GET /bundles/:id/documents — what is actually in one bundle.
//
// The gap this closes: until now a bundle's contents could only be read through
// the agent it was attached to (`AGENT_SELECT` embeds them), so a bundle nobody
// had attached was a name and a count with no screen behind it — including every
// bundle on the day it is created, which is the day somebody most wants to look
// inside it.
//
// Two queries rather than one, and the first is not redundant. `documents` under
// RLS answers a bundle in another workspace with an empty list, which is the
// same reply as an empty bundle; reading the bundle first separates "not yours"
// from "nothing in it". Same pattern as the upload route below.
bundles.get("/bundles/:id/documents", async (c) => {
  const db = c.get("db");
  const bundleId = c.req.param("id");

  const { data: bundle, error: bundleError } = await db
    .from("knowledge_bundles")
    .select("id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bundleError) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);

  const { data, error } = await db
    .from("documents")
    .select(LISTING_SELECT)
    .eq("bundle_id", bundleId)
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: "failed to load documents" }, 500);

  // "Added by" in the Knowledge table (A6). `created_by` (0037) points at
  // auth.users, which PostgREST cannot embed, so the names are one more read:
  // profiles the caller shares a workspace with, which an uploader in this
  // bundle's workspace is. A name that does not come back stays null.
  const rows = data ?? [];
  const uploaderIds = [
    ...new Set(rows.map((r) => r.created_by as string | null).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const { data: profiles } = await db.from("profiles").select("id, name").in("id", uploaderIds);
    for (const p of profiles ?? []) names.set(p.id as string, (p.name as string | null) ?? null);
  }

  return c.json(
    rows.map((r) => {
      const by = (r.created_by as string | null) ?? null;
      return {
        ...mapDocument(r),
        createdBy: by ? { id: by, name: names.get(by) ?? null } : null,
      };
    }),
  );
});

// POST /bundles
bundles.post("/bundles", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 400);

  const { data, error } = await db
    .from("knowledge_bundles")
    .insert({
      workspace_id: workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      created_by: user.id,
      scope: parsed.data.shared ? "workspace" : "owner",
    })
    .select(BUNDLE_SELECT)
    .single();
  if (error || !data) return c.json({ error: "failed to create bundle" }, 500);
  return c.json(mapBundle(data, user.id), 201);
});

// PATCH /bundles/:id
bundles.patch("/bundles/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { shared, ...rest } = parsed.data;
  const patch = {
    ...rest,
    ...(shared === undefined ? {} : { scope: shared ? "workspace" : "owner" }),
  };
  const { error: upErr } = await db.from("knowledge_bundles").update(patch).eq("id", id);
  // 0106's guard: only the person who made a bundle shares it or unshares it.
  if (upErr?.code === "42501") {
    return c.json({ error: "only the person who made this bundle can change who sees it" }, 403);
  }
  if (upErr) return c.json({ error: "failed to update bundle" }, 500);

  const { data, error } = await db
    .from("knowledge_bundles")
    .select(BUNDLE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load bundle" }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(mapBundle(data, c.get("user").id));
});

// DELETE /bundles/:id
//
// Marks the bundle and its documents together (0037). The documents carry
// `deleted_via = <bundle id>`, which is what keeps them out of the trash as
// separate entries and brings exactly them back when the bundle is restored —
// a document somebody deleted on its own beforehand keeps its own deletion.
//
// Their chunks and their uploaded files are untouched for thirty days, so
// restoring costs no re-embedding. It also means a deleted bundle goes on
// occupying storage until the sweeper reaches it.
bundles.delete("/bundles/:id", async (c) => {
  const failure = await callDeletionFn(
    c.get("db"),
    "soft_delete_bundle",
    { p_bundle_id: c.req.param("id") },
    "failed to delete bundle",
  );
  if (failure) return c.json({ error: failure.message }, failure.status);
  return c.json({ ok: true });
});

// POST /agents/:id/bundles/:bundleId — attach
bundles.post("/agents/:id/bundles/:bundleId", async (c) => {
  const db = c.get("db");
  const { error } = await db
    .from("agent_bundles")
    .insert({ agent_id: c.req.param("id"), bundle_id: c.req.param("bundleId") });
  // Choosing what an agent reads is editing it (0104): somebody the agent is
  // shared with to use is refused by the policy, and told so.
  if (error?.code === "42501") {
    return c.json(
      {
        error:
          "you need edit access to this agent to change what it reads, and a private bundle " +
          "can only be attached by the person who made it",
      },
      403,
    );
  }
  if (error) return c.json({ error: "failed to attach bundle" }, 500);
  return c.json({ ok: true }, 201);
});

// DELETE /agents/:id/bundles/:bundleId — detach
bundles.delete("/agents/:id/bundles/:bundleId", async (c) => {
  const db = c.get("db");
  const { error } = await db
    .from("agent_bundles")
    .delete()
    .eq("agent_id", c.req.param("id"))
    .eq("bundle_id", c.req.param("bundleId"));
  if (error) return c.json({ error: "failed to detach bundle" }, 500);
  return c.json({ ok: true });
});

// POST /bundles/:id/documents/upload — multipart `file`; chunks+embeds best-effort.
//
// The limit is on the whole body, not on the file. It used to be a
// `Content-Length` comparison followed by `file.size`, which bounded the file
// and nothing else: a request sent without the header was read in full, and
// the browser-extracted `text` field beside the file was never measured at all
// — and that text, not the file, is what gets chunked and embedded. `bodyLimit`
// counts the stream as it arrives, so a body with no header is cut off at the
// limit rather than believed.
//
// The file and its text are allowed for separately. One limit over both refused
// a PDF the form had just accepted whenever its text pushed the body over.
bundles.use(
  "/bundles/:id/documents/upload",
  uploadLimit(
    MAX_DIRECT_UPLOAD_BYTES,
    "file too large for one request (max 10 MB) — send it in parts",
    MAX_EXTRACTED_TEXT_BYTES,
  ),
);
// The one-request upload, for small files and API callers. It stores the file
// and the text, queues the document and returns; indexing is the job's
// (`lib/indexing`). A file is read here only to refuse one that has no text
// before it costs anything — the same answer, sooner, that the job would give.
bundles.post("/bundles/:id/documents/upload", async (c) => {
  const db = c.get("db");
  const bundleId = c.req.param("id");

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no file provided" }, 400);
  if (!ALLOWED_EXT.has(extOf(file.name))) return c.json({ error: "unsupported file type" }, 400);
  if (file.size === 0) return c.json({ error: "empty file" }, 400);
  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    return c.json({ error: "file too large for one request (max 10 MB) — send it in parts" }, 413);
  }

  // Optional client-extracted text (PDFs are parsed in the browser and sent
  // here, since pdf.js can't run reliably on the Workers runtime).
  const providedText = typeof body["text"] === "string" ? (body["text"] as string) : "";
  if (providedText.length > MAX_EXTRACTED_TEXT_BYTES) {
    return c.json({ error: "the extracted text is too large to index" }, 413);
  }

  // Read the text before anything is stored, and refuse a file there is no text
  // in. A scan and a renamed binary both used to upload successfully and land
  // as a document that is listed, named to the model on every turn, and
  // impossible to retrieve a sentence of. Same reasoning as the credit refusal
  // below: the failure that looks like success is the expensive one.
  const bytes = await file.arrayBuffer();
  let fullText = providedText.slice(0, MAX_INDEX_CHARS);
  if (!fullText) {
    try {
      fullText =
        (await extractFromBytes(file.name, new Uint8Array(bytes), MAX_INDEX_CHARS))?.text ?? "";
    } catch (e) {
      if (e instanceof UnreadableFile) return c.json({ error: e.message }, 422);
      throw e;
    }
  }
  // A scanned PDF is taken when it can be read as one (`lib/formats/read/ocr`):
  // the indexing job sends it to Claude. Otherwise, and for anything else
  // without text, refused here as it always was.
  const scan = extOf(file.name) === "pdf" && ocrAvailable(c.env) && file.size <= OCR_MAX_BYTES;
  if (!hasIndexableText(fullText) && !scan) {
    return c.json({ error: noTextMessage(file.name) }, 422);
  }
  if (!hasIndexableText(fullText)) fullText = "";

  // Resolve the bundle's workspace (also acts as an RLS existence check).
  const { data: bundle, error: bErr } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bErr) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);

  // Refused outright rather than stored-but-unindexed: a document the agent
  // cannot retrieve from looks uploaded and behaves as if it were never there.
  // The bundle's workspace pays.
  const denied = await guardCredits(c, bundle.workspace_id as string);
  if (denied) return denied;

  // Derived from the extension that was just validated, never from the
  // client's own `file.type`: that value used to be stored here and served
  // back verbatim on download, which made a `.pdf` claiming `text/html` into
  // a `blob:` document on this app's origin once the preview framed it.
  const contentType = contentTypeFor(file.name);
  const r2Key = `${bundleId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const store = getDocStore(c.env);
  try {
    await store.put(r2Key, bytes, { contentType });
    // The text, kept whole beside the file: what the indexing job reads, and
    // what any later reindex reads. See `lib/document-text.ts`.
    if (fullText) {
      const encoded = new TextEncoder().encode(fullText);
      await store.put(sidecarKey(r2Key), encoded.buffer as ArrayBuffer, {
        contentType: "text/plain; charset=utf-8",
      });
    }
  } catch (e) {
    console.error("failed to store document", e);
    for (const key of storedKeysOf(r2Key)) await store.delete(key).catch(() => {});
    return c.json({ error: "failed to store the document; check the server logs" }, 500);
  }

  const { data: doc, error } = await db
    .from("documents")
    .insert({
      bundle_id: bundleId,
      name: file.name,
      size: file.size,
      r2_key: r2Key,
      content: fullText.slice(0, EXCERPT_LIMIT),
      index_status: "queued",
    })
    .select(UPLOADED_SELECT)
    .single();
  if (error || !doc) {
    for (const key of storedKeysOf(r2Key)) {
      try {
        await store.delete(key);
      } catch (e) {
        console.error("r2 rollback failed", e);
      }
    }
    console.error("failed to insert document row", error);
    return c.json({ error: "failed to save document" }, 500);
  }

  deferred(c, kickIndexJob(c.env, doc.id));
  return c.json(mapDocument({ ...doc, document_chunks: [{ count: 0 }] }), 201);
});

// POST /bundles/:id/documents/url — a web page, added as a document.
//
// Fetched the way a routine's web source is (`lib/routines/source.ts`): https
// or http to a public address only, every redirect re-checked, the body capped
// at 2 MB, no fetching ourselves. Stored as the HTML it was, under the page's
// title, and indexed like any upload — the job reads the text out of the
// markup. A page is a snapshot: adding it again later is how it is refreshed.
const urlSchema = z.object({ url: z.string().url().max(2048) });

bundles.post("/bundles/:id/documents/url", async (c) => {
  const db = c.get("db");
  const bundleId = c.req.param("id");
  const parsed = urlSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "a web address is required" }, 400);

  const { data: bundle, error: bErr } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bErr) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);
  const denied = await guardCredits(c, bundle.workspace_id as string);
  if (denied) return denied;

  let html: string;
  try {
    const page = await fetchSource(
      { source_kind: "web", source_config: { url: parsed.data.url } },
      null,
      {
        fetchImpl: fetch.bind(globalThis),
        ownHosts: ownHostsFrom(c.env),
      },
    );
    if (page.status !== "content") throw new Error("the page sent nothing back");
    html = page.text;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return c.json({ error: `could not fetch that page: ${reason}` }, 422);
  }

  const text = htmlToText(html);
  if (!hasIndexableText(text)) {
    return c.json(
      { error: "that page has no readable text — it may need a browser to render" },
      422,
    );
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const host = new URL(parsed.data.url).hostname.replace(/^www\./, "");
  const name = `${(title ? decodeEntities(title) : host).slice(0, 180)}.html`;
  const r2Key = `${bundleId}/${crypto.randomUUID()}-${safeName(name)}`;
  const store = getDocStore(c.env);
  const bytes = new TextEncoder().encode(html);
  // The source address, at the top of the text the agent reads, so an answer
  // grounded on the page can say where it came from.
  const sidecar = new TextEncoder().encode(
    `Source: ${parsed.data.url}

${text}`.slice(0, MAX_INDEX_CHARS),
  );
  try {
    await store.put(r2Key, bytes.buffer as ArrayBuffer, { contentType: contentTypeFor(name) });
    await store.put(sidecarKey(r2Key), sidecar.buffer as ArrayBuffer, {
      contentType: "text/plain; charset=utf-8",
    });
  } catch (e) {
    console.error("failed to store a fetched page", e);
    for (const key of storedKeysOf(r2Key)) await store.delete(key).catch(() => {});
    return c.json({ error: "failed to store the page" }, 500);
  }

  const { data: doc, error } = await db
    .from("documents")
    .insert({
      bundle_id: bundleId,
      name,
      size: bytes.byteLength,
      r2_key: r2Key,
      content: text.slice(0, EXCERPT_LIMIT),
      index_status: "queued",
    })
    .select(UPLOADED_SELECT)
    .single();
  if (error || !doc) {
    for (const key of storedKeysOf(r2Key)) await store.delete(key).catch(() => {});
    return c.json({ error: "you cannot add documents here" }, error?.code === "42501" ? 403 : 500);
  }
  deferred(c, kickIndexJob(c.env, doc.id));
  return c.json(mapDocument({ ...doc, document_chunks: [{ count: 0 }] }), 201);
});

// POST /admin/backfill-embeddings — embeds documents that have content but no
// chunks yet (e.g. rows created before RAG, or where upload-time embedding failed).
// Idempotent: a document with existing chunks is skipped, unless `?force=1`,
// which re-embeds everything — what an embedding-width change needs, and what
// the error that tells an operator to come here (`lib/embeddings.ts`) means.
// Reads through the caller's own client, so it covers the workspaces they can see.
bundles.post("/admin/backfill-embeddings", async (c) => {
  // Operator-only maintenance endpoint. Requires the ADMIN_API_KEY shared secret
  // (set via `wrangler secret put ADMIN_API_KEY`) in the `x-admin-key` header.
  // Fails closed when the secret is unset so it can't be triggered accidentally.
  const provided = c.req.header("x-admin-key") ?? "";
  const expected = c.env.ADMIN_API_KEY ?? "";
  if (expected.length === 0 || !timingSafeEqualStr(provided, expected)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const db = c.get("db");
  const force = c.req.query("force") === "1";

  const { data: docs, error } = await db
    .from("documents")
    .select("id,bundle_id,name,r2_key,content,knowledge_bundles(workspace_id)")
    .not("content", "is", null);
  if (error) return c.json({ error: "failed to load documents" }, 500);

  let processed = 0;
  let skipped = 0;
  for (const d of (docs ?? []) as unknown as Array<{
    id: string;
    bundle_id: string;
    name: string;
    r2_key: string | null;
    content: string | null;
    knowledge_bundles: { workspace_id: string } | null;
  }>) {
    if (!force) {
      const { count } = await db
        .from("document_chunks")
        .select("id", { count: "exact", head: true })
        .eq("document_id", d.id);
      if ((count ?? 0) > 0) {
        skipped++;
        continue;
      }
    }
    const workspaceId = d.knowledge_bundles?.workspace_id;
    if (!workspaceId || !d.content) {
      skipped++;
      continue;
    }
    // The whole text, not the excerpt on the row — which is all this used to
    // embed, so a backfilled document was searchable for its first 8,000
    // characters and silent about the rest.
    let text: string;
    try {
      const found = await readStoredText(d.r2_key ? getDocStore(c.env) : null, d, MAX_INDEX_CHARS);
      if (!found) {
        skipped++;
        continue;
      }
      text = found.text;
    } catch (e) {
      console.error("backfill read failed", d.id, e);
      skipped++;
      continue;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }
    try {
      // Not charged to anyone's credits: this is the operator repairing their own
      // data, not a user asking for work. It is gated by ADMIN_API_KEY above.
      const { vectors } = await embedTexts(c.env, chunks);
      const rows = chunks.map((ch, i) => ({
        document_id: d.id,
        bundle_id: d.bundle_id,
        workspace_id: workspaceId,
        chunk_index: i,
        content: ch,
        context: d.name,
        embedding: vectors[i],
      }));
      const { error: insErr } = await replaceChunks(db, d.id, rows, passageIndex(c.env));
      if (insErr) {
        console.error("backfill insert failed", d.id, insErr);
        skipped++;
        continue;
      }
      processed++;
    } catch (e) {
      console.error("backfill embed failed", d.id, e);
      skipped++;
    }
  }

  return c.json({ processed, skipped });
});

export { bundles };
