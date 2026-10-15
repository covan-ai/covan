import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapDocument } from "../lib/dto";
import {
  ALLOWED_EXT,
  contentTypeFor,
  EXCERPT_LIMIT,
  extOf,
  hasIndexableText,
  MAX_INDEX_CHARS,
  MAX_UPLOAD_BYTES,
  noTextMessage,
  safeName,
} from "../lib/extract";
import { getDocStore, type DocStore } from "../lib/docstore";
import { guardCredits } from "../lib/entitlements/guard";
import { uploadLimit } from "../lib/body-limit";
import { sidecarKey, storedKeysOf } from "../lib/document-text";
import { hmacSha256Hex, timingSafeEqual } from "../lib/hmac";
import { deferred } from "../lib/defer";
import { kickIndexJob } from "../lib/indexing/host";
import { ocrAvailable, OCR_MAX_BYTES } from "../lib/formats/read/ocr";
import { UPLOADED_SELECT } from "./bundles";

/**
 * A file uploaded in parts, for anything past the one-request route's 10 MB.
 *
 *   POST /bundles/:id/uploads     { name, size, withText }  → { token, partSize }
 *   PUT  /uploads/parts?n=&to=    the part's bytes          → { partNumber, etag }
 *   POST /uploads/complete        { token, parts, textParts } → the document
 *   POST /uploads/abort           { token }
 *
 * Every request is small enough for any route limit, and no request holds the
 * file: parts go straight to the store's multipart upload (`DocStore`), and the
 * store assembles them. `withText` opens a second upload beside the first for
 * the text the browser extracted from a PDF, which becomes the document's
 * sidecar (`lib/document-text.ts`).
 *
 * The token is what makes this stateless: it names the bundle, the key, the
 * store's upload ids and the size the caller declared, and it is signed, so a
 * part cannot be written to a key the caller was not given and `complete`
 * cannot claim a file is something it was not. Nothing is in the database
 * until `complete` inserts the document — through the caller's own client, so
 * the documents policies decide, as they do for every other upload. An upload
 * nobody completes is cleaned up by the store (R2 aborts incomplete multipart
 * uploads after a week) or left in the filesystem store's `.multipart`.
 */

/** Every part but the last is exactly this. R2 needs at least 5 MiB. */
export const PART_BYTES = 8 * 1024 * 1024;
/** The text a PDF's upload may carry, in parts: comfortably past `MAX_INDEX_CHARS`. */
const MAX_TEXT_PARTS = 4;
/** How long a token stays good: long enough for 100 MB on a slow line. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

type UploadToken = {
  bundleId: string;
  workspaceId: string;
  userId: string;
  key: string;
  uploadId: string;
  textUploadId: string | null;
  name: string;
  size: number;
  expires: number;
};

const uploads = new Hono<AppEnv>();

async function tokenSecret(secret: string): Promise<string> {
  // Domain-separated from every other use of the key.
  return hmacSha256Hex(secret, "covan:upload-token:v1");
}

async function sign(env: AppEnv["Bindings"], token: UploadToken): Promise<string> {
  const body = btoa(JSON.stringify(token))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const mac = await hmacSha256Hex(await tokenSecret(env.ROUTINE_SECRET_KEY), body);
  return `${body}.${mac}`;
}

async function verify(
  env: AppEnv["Bindings"],
  raw: string | undefined,
  userId: string,
): Promise<UploadToken | null> {
  if (!raw) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const expected = await hmacSha256Hex(await tokenSecret(env.ROUTINE_SECRET_KEY), body);
  if (!timingSafeEqual(mac, expected)) return null;
  let token: UploadToken;
  try {
    token = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as UploadToken;
  } catch {
    return null;
  }
  if (token.userId !== userId || token.expires < Date.now()) return null;
  return token;
}

const startSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  withText: z.boolean().optional(),
});

uploads.post("/bundles/:id/uploads", async (c) => {
  const db = c.get("db");
  const bundleId = c.req.param("id");
  const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "name and size are required" }, 400);
  const { name, size, withText } = parsed.data;

  if (!ALLOWED_EXT.has(extOf(name))) return c.json({ error: "unsupported file type" }, 400);
  if (size > MAX_UPLOAD_BYTES) return c.json({ error: "file too large (max 100 MB)" }, 413);

  const { data: bundle, error } = await db
    .from("knowledge_bundles")
    .select("id,workspace_id")
    .eq("id", bundleId)
    .maybeSingle();
  if (error) return c.json({ error: "failed to load bundle" }, 500);
  if (!bundle) return c.json({ error: "not found" }, 404);

  // Asked before a byte is accepted, so a viewer is not let upload 100 MB to be
  // refused at the end. The insert at `complete` is still what decides.
  const { data: canWrite } = await db.rpc("can_write_in_workspace", {
    p_workspace_id: bundle.workspace_id,
  });
  if (canWrite === false) return c.json({ error: "you cannot add documents here" }, 403);

  const denied = await guardCredits(c, bundle.workspace_id as string);
  if (denied) return denied;

  const store = getDocStore(c.env);
  const key = `${bundleId}/${crypto.randomUUID()}-${safeName(name)}`;
  const uploadId = await store.createMultipart(key, { contentType: contentTypeFor(name) });
  const textUploadId = withText
    ? await store.createMultipart(sidecarKey(key), { contentType: "text/plain; charset=utf-8" })
    : null;

  const token = await sign(c.env, {
    bundleId,
    workspaceId: bundle.workspace_id as string,
    userId: c.get("user").id,
    key,
    uploadId,
    textUploadId,
    name,
    size,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return c.json({ token, partSize: PART_BYTES }, 201);
});

uploads.use("/uploads/parts", uploadLimit(PART_BYTES, "a part is larger than the part size"));
uploads.put("/uploads/parts", async (c) => {
  const token = await verify(c.env, c.req.header("x-upload-token"), c.get("user").id);
  if (!token) return c.json({ error: "this upload has expired — start it again" }, 401);

  const n = Number(c.req.query("n"));
  const toText = c.req.query("to") === "text";
  const lastPart = Math.max(1, Math.ceil(token.size / PART_BYTES));
  if (!Number.isInteger(n) || n < 1 || n > (toText ? MAX_TEXT_PARTS : lastPart)) {
    return c.json({ error: "no such part" }, 400);
  }
  if (toText && !token.textUploadId) return c.json({ error: "this upload carries no text" }, 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty part" }, 400);
  // Every file part but the last is exactly the part size: R2 refuses to
  // assemble anything else, and finding that out at `complete` would throw the
  // whole upload away.
  if (!toText && n < lastPart && body.byteLength !== PART_BYTES) {
    return c.json({ error: `every part but the last must be ${PART_BYTES} bytes` }, 400);
  }

  const store = getDocStore(c.env);
  const part = toText
    ? await store.uploadPart(sidecarKey(token.key), token.textUploadId!, n, body)
    : await store.uploadPart(token.key, token.uploadId, n, body);
  return c.json(part);
});

const partSchema = z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string() }));
const completeSchema = z.object({
  token: z.string(),
  parts: partSchema.min(1),
  textParts: partSchema.optional(),
});

uploads.post("/uploads/complete", async (c) => {
  const db = c.get("db");
  const parsed = completeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "token and parts are required" }, 400);
  const token = await verify(c.env, parsed.data.token, c.get("user").id);
  if (!token) return c.json({ error: "this upload has expired — start it again" }, 401);

  const store = getDocStore(c.env);
  const discard = () => discardUpload(store, token);

  try {
    await store.completeMultipart(token.key, token.uploadId, parsed.data.parts);
    if (token.textUploadId && parsed.data.textParts?.length) {
      await store.completeMultipart(
        sidecarKey(token.key),
        token.textUploadId,
        parsed.data.textParts,
      );
    } else if (token.textUploadId) {
      await store.abortMultipart(sidecarKey(token.key), token.textUploadId);
    }
  } catch (e) {
    console.error("could not assemble an upload", e);
    await discard();
    return c.json({ error: "the upload could not be put together — try it again" }, 400);
  }

  // The declared size is what was checked against the limit, so the assembled
  // file has to be that size — not one byte more.
  const head = await store.getRange(token.key, 0, 0);
  if (!head || head.size !== token.size) {
    await discard();
    return c.json({ error: "the file that arrived is not the size that was declared" }, 400);
  }

  // A PDF's text is the browser's to supply. Without any — a scan, or a PDF the
  // browser could not open — it is refused now, with the reason, rather than
  // stored to fail later.
  let excerpt = "";
  if (extOf(token.name) === "pdf") {
    const sidecar = await store.get(sidecarKey(token.key));
    const text = sidecar ? new TextDecoder().decode(await sidecar.arrayBuffer()) : "";
    // A scan is taken when it can be read as one; see `lib/formats/read/ocr`.
    const scan = ocrAvailable(c.env) && token.size <= OCR_MAX_BYTES;
    if (!hasIndexableText(text)) {
      if (!scan) {
        await discard();
        return c.json({ error: noTextMessage(token.name) }, 422);
      }
      await store.delete(sidecarKey(token.key)).catch(() => {});
    } else {
      excerpt = text.slice(0, Math.min(EXCERPT_LIMIT, MAX_INDEX_CHARS));
    }
  }

  const { data: doc, error } = await db
    .from("documents")
    .insert({
      bundle_id: token.bundleId,
      name: token.name,
      size: token.size,
      r2_key: token.key,
      content: excerpt,
      index_status: "queued",
    })
    .select(UPLOADED_SELECT)
    .single();
  if (error || !doc) {
    console.error("failed to insert document row", error);
    await discard();
    return c.json({ error: "failed to save document" }, error?.code === "42501" ? 403 : 500);
  }

  deferred(c, kickIndexJob(c.env, doc.id));
  return c.json(mapDocument({ ...doc, document_chunks: [{ count: 0 }] }), 201);
});

uploads.post("/uploads/abort", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
  const token = await verify(c.env, body?.token, c.get("user").id);
  if (!token) return c.json({ ok: true });
  await discardUpload(getDocStore(c.env), token);
  return c.json({ ok: true });
});

async function discardUpload(store: DocStore, token: UploadToken): Promise<void> {
  await store.abortMultipart(token.key, token.uploadId).catch(() => {});
  if (token.textUploadId) {
    await store.abortMultipart(sidecarKey(token.key), token.textUploadId).catch(() => {});
  }
  for (const key of storedKeysOf(token.key)) await store.delete(key).catch(() => {});
}

export { uploads };
