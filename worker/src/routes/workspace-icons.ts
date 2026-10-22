import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getDocStore } from "../lib/docstore";
import { callerWorkspaceId } from "../lib/workspace";
import { uploadLimit } from "../lib/body-limit";
import {
  AVATAR_MAX_BYTES,
  FILE_RE,
  USER_ID_RE,
  avatarPath,
  contentTypeForAvatarFile,
  sniffImage,
  workspaceIconKey,
  workspaceIconKeyFromUrl,
} from "../lib/avatars";

/**
 * A workspace's icon (Settings › General, A9), and the route that shows it.
 *
 * `routes/avatars.ts` with a workspace in place of a person, and the same
 * order: the object is written before the row points at it and deleted again
 * if the row refuses, and the old object goes only once the row has moved on.
 * The row is written through the caller's own client, so 0001's
 * `workspaces_update_admin` decides who may change it — a member's upload
 * matches no row and is taken back.
 */
const workspaceIcons = new Hono<AppEnv>();

const TOO_LARGE = { error: "image too large (max 2 MB)" };

async function forget(env: AppEnv["Bindings"], key: string | null, why: string) {
  if (!key) return;
  try {
    await getDocStore(env).delete(key);
  } catch (e) {
    console.error(`workspace icon: ${why}`, key, e);
  }
}

async function currentIconKey(db: AppEnv["Variables"]["db"], workspaceId: string) {
  const { data } = await db
    .from("workspaces")
    .select("icon_url")
    .eq("id", workspaceId)
    .maybeSingle();
  return workspaceIconKeyFromUrl(
    (data?.icon_url as string | null | undefined) ?? null,
    workspaceId,
  );
}

// PUT /workspace/icon — multipart `file`; PNG, JPEG or WebP, at most 2 MB.
workspaceIcons.put("/workspace/icon", uploadLimit(AVATAR_MAX_BYTES, TOO_LARGE.error), async (c) => {
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const contentLength = parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > AVATAR_MAX_BYTES + 64 * 1024) {
    return c.json(TOO_LARGE, 413);
  }
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.["file"];
  if (!(file instanceof File)) return c.json({ error: "no image provided" }, 400);
  if (file.size === 0) return c.json({ error: "empty file" }, 400);
  if (file.size > AVATAR_MAX_BYTES) return c.json(TOO_LARGE, 413);

  const bytes = await file.arrayBuffer();
  const type = sniffImage(new Uint8Array(bytes));
  if (!type) return c.json({ error: "only PNG, JPEG or WebP images" }, 415);

  const previous = await currentIconKey(db, workspaceId);
  const key = workspaceIconKey(workspaceId, type);
  try {
    await getDocStore(c.env).put(key, bytes, { contentType: type });
  } catch (e) {
    console.error("workspace icon: failed to store", e);
    return c.json({ error: "failed to store the image" }, 500);
  }

  const { data: updated, error } = await db
    .from("workspaces")
    .update({ icon_url: avatarPath(key) })
    .eq("id", workspaceId)
    .select("icon_url");
  if (error || !updated || updated.length === 0) {
    if (error) console.error("workspace icon: update failed", error);
    await forget(c.env, key, "rollback failed");
    return error
      ? c.json({ error: "failed to save the icon" }, 500)
      : c.json({ error: "only workspace admins can change the icon" }, 403);
  }
  if (previous && previous !== key) await forget(c.env, previous, "old icon not removed");

  return c.json({ iconUrl: updated[0]!.icon_url as string });
});

// DELETE /workspace/icon — back to the letter.
workspaceIcons.delete("/workspace/icon", async (c) => {
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const previous = await currentIconKey(db, workspaceId);
  const { data: updated, error } = await db
    .from("workspaces")
    .update({ icon_url: null })
    .eq("id", workspaceId)
    .select("id");
  if (error || !updated || updated.length === 0) {
    if (error) console.error("workspace icon: update failed", error);
    return error
      ? c.json({ error: "failed to remove the icon" }, 500)
      : c.json({ error: "only workspace admins can change the icon" }, 403);
  }
  await forget(c.env, previous, "removed icon not deleted");
  return c.json({ iconUrl: null });
});

/**
 * GET /workspace-icons/:workspaceId/:file — the icon, to anybody holding the
 * URL, for `routes/avatars.ts`' reasons: an `<img>` sends no token, and the
 * 128 random bits in the name are handed out only to the workspace's members.
 */
const workspaceIconsPublic = new Hono<AppEnv>();

workspaceIconsPublic.get("/workspace-icons/:workspaceId/:file", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const file = c.req.param("file");
  if (!USER_ID_RE.test(workspaceId) || !FILE_RE.test(file)) {
    return c.json({ error: "not found" }, 404);
  }
  const contentType = contentTypeForAvatarFile(file);
  if (!contentType) return c.json({ error: "not found" }, 404);

  const object = await getDocStore(c.env).get(`workspace-icons/${workspaceId}/${file}`);
  if (!object) return c.json({ error: "not found" }, 404);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

export { workspaceIcons, workspaceIconsPublic };
