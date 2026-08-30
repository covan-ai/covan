import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapBundle, mapDocument } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";
import { chunkText, embedTexts } from "../lib/embeddings";
import { extractDocumentText, hasIndexableText } from "../lib/extract";
import { getDocStore } from "../lib/docstore";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { embeddingCost } from "../lib/entitlements";
import { insertChunkRows } from "../lib/chunk-store";

const bundles = new Hono<AppEnv>();

const BUNDLE_SELECT = "id,name,description,created_at,documents(count)";

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
const updateSchema = z
  .object({ name: z.string().min(1).optional(), description: z.string().optional() })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field required" });

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXT = new Set(["md", "markdown", "txt", "csv", "json", "pdf"]);
const EXCERPT_LIMIT = 8000;

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
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
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json([]);

  const { data, error } = await db
    .from("knowledge_bundles")
    .select(BUNDLE_SELECT)
    .eq("workspace_id", workspaceId)
    .order("created_at");
  if (error) return c.json({ error: "failed to load bundles" }, 500);
  return c.json((data ?? []).map(mapBundle));
});

// POST /bundles
bundles.post("/bundles", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 400);

  const { data, error } = await db
    .from("knowledge_bundles")
    .insert({
      workspace_id: workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      created_by: user.id,
    })
    .select(BUNDLE_SELECT)
    .single();
  if (error || !data) return c.json({ error: "failed to create bundle" }, 500);
  return c.json(mapBundle(data), 201);
});

// PATCH /bundles/:id
bundles.patch("/bundles/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { error: upErr } = await db.from("knowledge_bundles").update(parsed.data).eq("id", id);
  if (upErr) return c.json({ error: "failed to update bundle" }, 500);

  const { data, error } = await db
    .from("knowledge_bundles")
    .select(BUNDLE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load bundle" }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(mapBundle(data));
});

// DELETE /bundles/:id
bundles.delete("/bundles/:id", async (c) => {
  const db = c.get("db");
  const { error } = await db.from("knowledge_bundles").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: "failed to delete bundle" }, 500);
  return c.json({ ok: true });
});

// POST /agents/:id/bundles/:bundleId — attach
bundles.post("/agents/:id/bundles/:bundleId", async (c) => {
  const db = c.get("db");
  const { error } = await db
    .from("agent_bundles")
    .insert({ agent_id: c.req.param("id"), bundle_id: c.req.param("bundleId") });
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
bundles.post("/bundles/:id/documents/upload", async (c) => {
  const db = c.get("db");
  const bundleId = c.req.param("id");

  // Refused outright rather than stored-but-unindexed: a document the agent
  // cannot retrieve from looks uploaded and behaves as if it were never there.
  const denied = await guardQuota(c);
  if (denied) return denied;

  const contentLength = parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_SIZE) {
    return c.json({ error: "file too large (max 10 MB)" }, 413);
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no file provided" }, 400);
  if (!ALLOWED_EXT.has(extOf(file.name))) return c.json({ error: "unsupported file type" }, 400);
  if (file.size === 0) return c.json({ error: "empty file" }, 400);
  if (file.size > MAX_SIZE) return c.json({ error: "file too large (max 10 MB)" }, 413);

  // Optional client-extracted text (PDFs are parsed in the browser and sent
  // here, since pdf.js can't run reliably on the Workers runtime).
  const providedText = typeof body["text"] === "string" ? (body["text"] as string) : "";

  // Read the text before anything is stored, and refuse a file there is no text
  // in. A scan and a renamed binary both used to upload successfully and land
  // as a document that is listed, named to the model on every turn, and
  // impossible to retrieve a sentence of. Same reasoning as the quota refusal
  // above: the failure that looks like success is the expensive one.
  const bytes = await file.arrayBuffer();
  const fullText = providedText || extractDocumentText(file.name, bytes);
  if (!hasIndexableText(fullText)) {
    return c.json(
      {
        error:
          extOf(file.name) === "pdf"
            ? "no readable text in this PDF — it looks like a scan, so run it through OCR and upload the text"
            : "no readable text in this file — check it is really the format its name claims",
      },
      422,
    );
  }

  // Resolve the bundle's workspace for chunk rows (also acts as an RLS existence check).
  const { data: bundle, error: bErr } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (bErr) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);

  const contentType = file.type || "application/octet-stream";
  const r2Key = `${bundleId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  // No document row exists yet at this point, so a failed put needs no
  // rollback — unlike the insert failure below, which cleans up a store
  // write that already landed.
  try {
    await getDocStore(c.env).put(r2Key, bytes, { contentType });
  } catch (e) {
    console.error("failed to store document", e);
    return c.json({ error: "failed to store the document; check the server logs" }, 500);
  }

  const content = fullText.slice(0, EXCERPT_LIMIT);

  const { data: doc, error } = await db
    .from("documents")
    .insert({ bundle_id: bundleId, name: file.name, size: file.size, r2_key: r2Key, content })
    .select("id,name,size")
    .single();
  if (error || !doc) {
    try {
      await getDocStore(c.env).delete(r2Key);
    } catch (e) {
      console.error("r2 rollback failed", e);
    }
    console.error("failed to insert document row", error);
    return c.json({ error: "failed to save document" }, 500);
  }

  // Best-effort embedding — document persists even if this fails.
  //
  // `chunkCount` is what the response reports. It has to be counted here rather
  // than read off the row above, which was selected before any of this ran and
  // without `document_chunks(count)` — so the reply used to say "0 chunks, not
  // indexed" about a document it had just embedded. The Knowledge tab never saw
  // it because that tab re-reads the agent, but anything trusting the reply was
  // told every upload was unretrievable.
  let chunkCount = 0;
  try {
    const chunks = chunkText(fullText);
    if (chunks.length > 0) {
      const embedded = await embedTexts(c.env, chunks);
      const vectors = embedded.vectors;
      await recordQuota(c, embeddingCost(embedded.tokens));
      const rows = chunks.map((ch, i) => ({
        document_id: doc.id,
        bundle_id: bundleId,
        workspace_id: bundle.workspace_id,
        chunk_index: i,
        content: ch,
        embedding: vectors[i],
      }));
      const { error: chunkErr } = await insertChunkRows(db, rows);
      if (chunkErr) console.error("failed to insert chunks", chunkErr);
      else chunkCount = rows.length;
    }
  } catch (e) {
    console.error("embedding failed (document saved without chunks)", e);
  }

  return c.json(mapDocument({ ...doc, document_chunks: [{ count: chunkCount }] }), 201);
});

// POST /admin/backfill-embeddings — embeds documents that have content but no
// chunks yet (e.g. rows created before RAG, or where upload-time embedding failed).
// Idempotent: a document with existing chunks is skipped.
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

  const { data: docs, error } = await db
    .from("documents")
    .select("id,bundle_id,content,knowledge_bundles(workspace_id)")
    .not("content", "is", null);
  if (error) return c.json({ error: "failed to load documents" }, 500);

  let processed = 0;
  let skipped = 0;
  for (const d of (docs ?? []) as unknown as Array<{
    id: string;
    bundle_id: string;
    content: string | null;
    knowledge_bundles: { workspace_id: string } | null;
  }>) {
    const { count } = await db
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", d.id);
    if ((count ?? 0) > 0) {
      skipped++;
      continue;
    }
    const workspaceId = d.knowledge_bundles?.workspace_id;
    if (!workspaceId || !d.content) {
      skipped++;
      continue;
    }
    const chunks = chunkText(d.content);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }
    try {
      // Not charged to anyone's quota: this is the operator repairing their own
      // data, not a user asking for work. It is gated by ADMIN_API_KEY above.
      const { vectors } = await embedTexts(c.env, chunks);
      const rows = chunks.map((ch, i) => ({
        document_id: d.id,
        bundle_id: d.bundle_id,
        workspace_id: workspaceId,
        chunk_index: i,
        content: ch,
        embedding: vectors[i],
      }));
      const { error: insErr } = await insertChunkRows(db, rows);
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
