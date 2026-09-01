import { Hono } from "hono";
import type { AppEnv } from "../types";
import { chunkText, embedTexts } from "../lib/embeddings";
import { extractDocumentText } from "../lib/extract";
import { mapDocument } from "../lib/dto";
import { getDocStore } from "../lib/docstore";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";
import { insertChunkRows } from "../lib/chunk-store";

const documents = new Hono<AppEnv>();

// DELETE /documents/:id — the row is the authority, and it goes first.
//
// This used to delete the stored object and then the row. RLS answers a delete
// it has no policy for by matching no rows and reporting no error, so a viewer
// — who passes documents_select_member but fails documents_delete_member —
// destroyed the bytes and got {ok:true} back, leaving a row pointing at a key
// that no longer exists. Deleting the row first, and reading back what was
// actually deleted, makes the refusal visible before anything is lost.
documents.delete("/documents/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data: row, error: selErr } = await db
    .from("documents")
    .select("id,r2_key")
    .eq("id", id)
    .maybeSingle();

  if (selErr) {
    return c.json({ error: "failed to load document" }, 500);
  }
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }

  const { data: deleted, error: delErr } = await db
    .from("documents")
    .delete()
    .eq("id", id)
    .select("id,r2_key");

  if (delErr) {
    return c.json({ error: "failed to delete document" }, 500);
  }
  // Visible above, not deletable: RLS refused. Not "already gone" — the select
  // two calls up found it.
  if (!deleted || deleted.length === 0) {
    return c.json({ error: "you do not have permission to delete this document" }, 403);
  }

  const key = deleted[0].r2_key;
  if (key) {
    try {
      await getDocStore(c.env).delete(key);
    } catch (e) {
      // Best-effort by design: the row is gone, so the document is gone as far
      // as the product is concerned. An orphaned object is a storage cost, not
      // a correctness problem, and failing the request here would be a lie.
      console.error("document store delete failed", e);
    }
  }

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
    .select("id,name,size,created_at,bundle_id,knowledge_bundles(workspace_id)")
    .eq("id", id)
    .maybeSingle();
  if (docErr) return c.json({ error: "failed to load document" }, 500);
  if (!doc) return c.json({ error: "not found" }, 404);
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
    .select("id,name,size,created_at,document_chunks(count)")
    .single();
  if (upErr || !updated) {
    // Put the passages back where the document still is.
    await db.from("document_chunks").update({ bundle_id: doc.bundle_id }).eq("document_id", id);
    return c.json({ error: "failed to move document" }, 500);
  }

  return c.json(mapDocument(updated));
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

  const contentType = obj.contentType || "application/octet-stream";
  const encodedName = encodeURIComponent(row.name);
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    },
  });
});

// POST /documents/:id/reindex — re-extract, re-chunk and re-embed one document,
// replacing its chunks. Recovers documents whose upload-time embedding failed
// (they exist but retrieve nothing) and refreshes chunks after a chunker change.
documents.post("/documents/:id/reindex", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  // Re-embedding a large document is real spend, and this endpoint can be
  // called repeatedly on the same one.
  const denied = await guardQuota(c);
  if (denied) return denied;

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

  // Re-decode the full text from R2 for text formats. PDFs can't be parsed
  // server-side (extractDocumentText returns ""), so fall back to the stored
  // excerpt, which holds the browser-extracted text captured at upload.
  let fullText = doc.content ?? "";
  if (doc.r2_key) {
    let obj;
    try {
      obj = await getDocStore(c.env).get(doc.r2_key);
    } catch (e) {
      console.error("failed to read document from store", e);
      return c.json({ error: "failed to load the document; check the server logs" }, 500);
    }
    if (obj) {
      const extracted = extractDocumentText(doc.name, await obj.arrayBuffer());
      if (extracted) fullText = extracted;
    }
  }

  const chunks = chunkText(fullText);
  if (chunks.length === 0) {
    return c.json({ error: "document has no indexable text" }, 400);
  }

  // Embed first — only touch the stored chunks once we have vectors in hand, so
  // a failure never leaves the document worse off than before.
  let vectors: number[][];
  try {
    const embedded = await embedTexts(c.env, chunks);
    vectors = embedded.vectors;
    await recordQuota(c, embeddingCost(embedded.tokens));
  } catch (e) {
    console.error("reindex embed failed", id, e);
    return c.json({ error: "failed to embed document" }, 502);
  }

  const { error: delErr } = await db.from("document_chunks").delete().eq("document_id", id);
  if (delErr) return c.json({ error: "failed to clear old chunks" }, 500);

  const rows = chunks.map((ch, i) => ({
    document_id: id,
    bundle_id: doc.bundle_id,
    workspace_id: workspaceId,
    chunk_index: i,
    content: ch,
    embedding: vectors[i],
  }));
  const { error: insErr } = await insertChunkRows(db, rows);
  if (insErr) return c.json({ error: "failed to save chunks" }, 500);

  return c.json(mapDocument({ ...doc, document_chunks: [{ count: chunks.length }] }));
});

export { documents };
