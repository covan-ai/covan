import { Hono } from "hono";
import type { AppEnv } from "../types";
import { chunkText, embedTexts } from "../lib/embeddings";
import { extractDocumentText } from "../lib/extract";
import { mapDocument } from "../lib/dto";
import { getDocStore } from "../lib/docstore";

const documents = new Hono<AppEnv>();

// DELETE /documents/:id — remove from DB (authoritative) + best-effort R2 delete.
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

  if (row.r2_key) {
    try {
      await getDocStore(c.env).delete(row.r2_key);
    } catch (e) {
      console.error("r2 delete failed", e);
    }
  }

  const { error: delErr } = await db.from("documents").delete().eq("id", id);
  if (delErr) {
    return c.json({ error: "failed to delete document" }, 500);
  }

  return c.json({ ok: true });
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

  const { data: doc, error } = await db
    .from("documents")
    .select("id,name,size,bundle_id,r2_key,content,knowledge_bundles(workspace_id)")
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
    vectors = await embedTexts(c.env.OPENAI_API_KEY, chunks);
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
  const { error: insErr } = await db.from("document_chunks").insert(rows);
  if (insErr) return c.json({ error: "failed to save chunks" }, 500);

  return c.json(mapDocument({ ...doc, document_chunks: [{ count: chunks.length }] }));
});

export { documents };
