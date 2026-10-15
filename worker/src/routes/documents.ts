import { Hono } from "hono";
import type { AppEnv } from "../types";
import { contentTypeFor, EXCERPT_LIMIT, extOf } from "../lib/extract";
import { mapDocument } from "../lib/dto";
import { getDocStore } from "../lib/docstore";
import { guardCredits } from "../lib/entitlements/guard";
import { sidecarKey } from "../lib/document-text";
import { deferred } from "../lib/defer";
import { kickIndexJob } from "../lib/indexing/host";
import { callDeletionFn } from "../lib/deletion";
import { markdownToDocx } from "../lib/formats/docx";
import { pdfRenderer } from "../lib/formats/pdf";

const documents = new Hono<AppEnv>();

// DELETE /documents/:id — a mark now, and the stored object stays put.
//
// It has twice been the case that this route destroyed bytes it should not
// have. First it deleted the object and then the row, so a viewer — who passes
// documents_select_member but fails documents_delete_member — destroyed the
// file and got {ok:true} back, because RLS answers an unpermitted delete by
// matching no rows and reporting no error. That was fixed by deleting the row
// first and reading back what actually went.
//
// Now neither goes. `soft_delete_document` marks the row and raises 42501 on
// refusal, so the viewer case is answered by an exception rather than by
// silence; and the object is deliberately left in the store, because a restored
// document that came back as a row pointing at a missing file would be worse
// than either outcome on its own. `worker/src/lib/purge.ts` deletes both,
// thirty days later, in the order account closure already uses: collect the
// keys, delete the rows, then delete the objects.
documents.delete("/documents/:id", async (c) => {
  const failure = await callDeletionFn(
    c.get("db"),
    "soft_delete_document",
    { p_document_id: c.req.param("id") },
    "failed to delete document",
  );
  if (failure) return c.json({ error: failure.message }, failure.status);

  return c.json({ ok: true });
});

// PATCH /documents/:id — move a document into another bundle.
//
// Two writes, and the second is the one that decides anything. Retrieval scope
// is read from `document_chunks.bundle_id` (match_chunks), not from the
// document row, so a move that re-points the row and leaves the chunks behind
// looks right and stops being right the moment the old bundle is detached or
// deleted. The chunks go first for that reason, and the document row only
// follows once they have actually moved.
documents.patch("/documents/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const body = (await c.req.json().catch(() => ({}))) as { bundleId?: unknown };
  const bundleId = typeof body.bundleId === "string" ? body.bundleId : "";
  if (!bundleId) return c.json({ error: "bundleId required" }, 400);

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select(
      "id,name,size,created_at,bundle_id,connection_id,external_url,document_chunks(count),knowledge_bundles(workspace_id)",
    )
    .eq("id", id)
    .maybeSingle();
  if (docErr) return c.json({ error: "failed to load document" }, 500);
  if (!doc) return c.json({ error: "not found" }, 404);
  // Already there: nothing to do, and the row goes back as it stands. The chunk
  // count is selected above so that this answer carries the document's real
  // indexing state — without it a move onto the bundle a document is already in
  // replied "not indexed" about a document with fifty passages.
  if (doc.bundle_id === bundleId) return c.json(mapDocument(doc));

  const { data: target, error: bundleErr } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bundleErr) return c.json({ error: "failed to load bundle" }, 500);
  if (!target) return c.json({ error: "not found" }, 404);

  // The policies would refuse a cross-workspace move anyway; this says why.
  const from = (doc as { knowledge_bundles?: { workspace_id?: string } | null }).knowledge_bundles
    ?.workspace_id;
  if (from && from !== target.workspace_id) {
    return c.json({ error: "a document cannot move to a bundle in another workspace" }, 400);
  }

  const { count } = await db
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", id);
  const expected = count ?? 0;

  if (expected > 0) {
    const { data: movedRows, error: chunkErr } = await db
      .from("document_chunks")
      .update({ bundle_id: bundleId })
      .eq("document_id", id)
      .select("id");
    if (chunkErr) return c.json({ error: "failed to move the document's chunks" }, 500);

    // RLS answers an update it has no policy for by matching no rows and
    // reporting no error. Without migration 0024 that is exactly what happens
    // here, and continuing would file the document under a bundle its passages
    // are not searchable in. Refuse instead, and leave the document where it is.
    if ((movedRows ?? []).length < expected) {
      console.error("chunk move affected fewer rows than expected", {
        id,
        expected,
        moved: (movedRows ?? []).length,
      });
      return c.json(
        { error: "could not move this document's indexed passages; nothing was changed" },
        500,
      );
    }
  }

  const { data: updated, error: upErr } = await db
    .from("documents")
    .update({ bundle_id: bundleId })
    .eq("id", id)
    .select("id,name,size,created_at,bundle_id,connection_id,external_url,document_chunks(count)")
    .single();
  if (upErr || !updated) {
    // Put the passages back where the document still is.
    await db.from("document_chunks").update({ bundle_id: doc.bundle_id }).eq("document_id", id);
    return c.json({ error: "failed to move document" }, 500);
  }

  return c.json(mapDocument(updated));
});

// GET /documents/:id/preview — the stored text, which is not the same thing as
// the file.
//
// `documents.content` is the extracted text cut at EXCERPT_LIMIT, and it is
// exactly what the no-match fallback in `routes/chat.ts` puts in front of the
// model. That makes it worth a screen of its own: the file can be downloaded
// and read anywhere, but what the agent has of it can only be read here.
//
// No store read, so this is one row and cheap enough to open on a click. The
// bytes are a separate request — `GET /documents/:id/download` — which the
// interface makes when it wants to render the file itself rather than say what
// was indexed.
documents.get("/documents/:id/preview", async (c) => {
  const db = c.get("db");

  const { data: doc, error } = await db
    .from("documents")
    .select(
      "id,name,size,created_at,bundle_id,connection_id,external_url,synced_at,content,document_chunks(count)",
    )
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load document" }, 500);
  if (!doc) return c.json({ error: "not found" }, 404);

  const excerpt = (doc as { content: string | null }).content ?? "";
  const syncedAt = (doc as { synced_at: string | null }).synced_at;

  return c.json({
    ...mapDocument(doc),
    excerpt,
    excerptLimit: EXCERPT_LIMIT,
    // What is knowable, stated as what is knowable. The text was sliced before
    // it was stored, so a full-length excerpt is a cut one — but nothing here
    // knows how much came after, and a document that happened to end exactly on
    // the limit reads the same way. The interface says the excerpt stops at
    // 8000 characters rather than claiming there is more.
    excerptTruncated: excerpt.length >= EXCERPT_LIMIT,
    syncedAt: syncedAt ? Date.parse(syncedAt) : null,
  });
});

// GET /documents/:id/download — stream bytes through the worker (native binding, no presign).
documents.get("/documents/:id/download", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data: row, error } = await db
    .from("documents")
    .select("name,r2_key")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return c.json({ error: "failed to load document" }, 500);
  }
  if (!row || !row.r2_key) {
    return c.json({ error: "not found" }, 404);
  }

  let obj;
  try {
    obj = await getDocStore(c.env).get(row.r2_key);
  } catch (e) {
    console.error("failed to read document from store", e);
    return c.json({ error: "failed to load the document; check the server logs" }, 500);
  }
  if (!obj) {
    return c.json({ error: "not found" }, 404);
  }

  // Derived from the row's own name, not from `obj.contentType`. Upload used to
  // store the type the uploader claimed and this line handed it back, so a
  // `.pdf` uploaded as `text/html` came back as `text/html` — and the preview
  // dialog turns those bytes into a `blob:` document, which runs on the app's
  // own origin where the session token is readable. Reading the name instead
  // means every object already in the store is served safely too, with no
  // backfill: the name is the part of the row the server decided.
  const contentType = contentTypeFor(row.name);
  const encodedName = encodeURIComponent(row.name);
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      // The header is the last word on the type: without this a browser is
      // free to sniff the bytes and reach its own conclusion, which is the
      // same hole one layer down.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    },
  });
});

/** What an export answers with, per format. */
const EXPORTS = {
  docx: {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  },
  pdf: { type: "application/pdf", extension: ".pdf" },
} as const;

/** `Q3 review.md` → `Q3 review.docx`. */
function exportName(name: string, extension: string): string {
  return `${name.replace(/\.(md|markdown)$/i, "")}${extension}`;
}

// GET /documents/:id/export/:format — a Markdown document as Word or PDF.
//
// Read through the caller's own client like the download above, so RLS decides
// whether the document exists for them. Only Markdown converts — every
// document the product writes itself is Markdown, and an uploaded PDF or Word
// file already is what somebody would export it to.
//
// PDF needs a browser to print with (`lib/formats/pdf.ts`). Without one this
// answers 501 with `fallback: "print"`, and the page prints the document in
// the person's own browser instead.
documents.get("/documents/:id/export/:format", async (c) => {
  const format = c.req.param("format");
  if (format !== "docx" && format !== "pdf") {
    return c.json({ error: "format must be docx or pdf" }, 400);
  }

  const { data: row, error } = await c
    .get("db")
    .from("documents")
    .select("name,r2_key")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load document" }, 500);
  if (!row || !row.r2_key) return c.json({ error: "not found" }, 404);
  if (!/\.(md|markdown)$/i.test(row.name)) {
    return c.json({ error: "only Markdown documents can be exported" }, 415);
  }

  const renderer = format === "pdf" ? pdfRenderer(c.env) : null;
  if (format === "pdf" && !renderer) {
    return c.json({ error: "this deployment cannot print PDFs", fallback: "print" }, 501);
  }

  let markdown: string;
  try {
    const obj = await getDocStore(c.env).get(row.r2_key);
    if (!obj) return c.json({ error: "not found" }, 404);
    markdown = new TextDecoder().decode(await obj.arrayBuffer());
  } catch (e) {
    console.error("failed to read document from store", e);
    return c.json({ error: "failed to load the document; check the server logs" }, 500);
  }

  let bytes: Uint8Array;
  try {
    bytes = renderer ? await renderer.render(markdown) : await markdownToDocx(markdown);
  } catch (e) {
    console.error(`failed to export a document as ${format}`, e);
    return c.json({ error: `failed to make the ${format.toUpperCase()}` }, 502);
  }

  const { type, extension } = EXPORTS[format];
  return new Response(bytes, {
    headers: {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exportName(row.name, extension))}`,
    },
  });
});

// POST /documents/:id/reindex — put a document back in the indexing queue.
//
// It used to re-embed the whole document inside this request, which had the
// upload's ceiling and the upload's way of failing half-way. Now it queues the
// job (`queue_document_index`, 0105) and returns at once; the explorer polls
// the document's status like any upload. The passages it has keep answering
// until the new set is complete.
//
// What it cannot do is invent text that was never kept: a PDF uploaded before
// its text was stored beside it has only its 8,000-character excerpt, and is
// refused here rather than indexed as though that were the document.
documents.post("/documents/:id/reindex", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data: doc, error } = await db
    .from("documents")
    .select("id,name,size,created_at,bundle_id,r2_key,content,knowledge_bundles(workspace_id)")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load document" }, 500);
  if (!doc) return c.json({ error: "not found" }, 404);

  const workspaceId = (doc as { knowledge_bundles?: { workspace_id?: string } | null })
    .knowledge_bundles?.workspace_id;
  if (!workspaceId) return c.json({ error: "document has no workspace" }, 400);

  // Re-embedding a large document is real spend, and this endpoint can be
  // called repeatedly on the same one. The document's workspace pays.
  const denied = await guardCredits(c, workspaceId);
  if (denied) return denied;

  if (extOf(doc.name) === "pdf" && doc.r2_key) {
    const sidecar = await getDocStore(c.env).getRange(sidecarKey(doc.r2_key), 0, 0);
    if (!sidecar && (doc.content ?? "").length >= EXCERPT_LIMIT) {
      return c.json(
        {
          error:
            "only the first part of this document's text was kept, so reindexing it would " +
            "shorten it — upload the file again instead",
          code: "excerpt_only",
        },
        409,
      );
    }
  }

  const { error: queueError } = await db.rpc("queue_document_index", { p_document_id: id });
  if (queueError) {
    if (queueError.code === "42501") return c.json({ error: "you cannot reindex this" }, 403);
    console.error("could not queue a reindex", queueError);
    return c.json({ error: "failed to queue the reindex" }, 500);
  }
  deferred(c, kickIndexJob(c.env, id));

  const { data: queued } = await db
    .from("documents")
    .select(
      "id,name,size,created_at,bundle_id,index_status,index_cursor,index_total,index_error,document_chunks(count)",
    )
    .eq("id", id)
    .maybeSingle();
  return c.json(mapDocument(queued ?? { ...doc, document_chunks: [{ count: 0 }] }), 202);
});

export { documents };
