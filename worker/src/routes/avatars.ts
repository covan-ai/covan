import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getDocStore } from "../lib/docstore";
import { mapProfile, PROFILE_COLUMNS, type ProfileRow } from "../lib/dto";
import {
  AVATAR_MAX_BYTES,
  FILE_RE,
  USER_ID_RE,
  avatarKey,
  avatarKeyFromUrl,
  avatarPath,
  contentTypeForAvatarFile,
  sniffImage,
} from "../lib/avatars";

/**
 * A profile photo somebody uploads, and the route that shows it to everybody
 * else.
 *
 * The bytes live in the document store and `profiles.avatar_url` holds the path
 * that serves them; `lib/avatars.ts` says why, and why the serving route is a
 * capability URL rather than an authenticated one.
 *
 * ORDER, the same as `documents.ts` and `account.ts`. On upload the new object
 * is written before the row points at it, and deleted again if the row refuses;
 * the old object goes only once the row has moved on. On removal the row goes
 * first and the object second. Either way the failure that can happen is bytes
 * nobody can reach, never a profile pointing at a photo that is not there.
 *
 * Every write goes through the caller's own client, so `profiles_update_own`
 * and 0082's column grant decide whose row and which column. Nothing here
 * reaches for the service role.
 *
 * Neither write asks `refuseIfKeyAuthenticated`. Changing your own photo
 * creates no access that outlives a key, which is the one thing
 * `lib/api-key-rule.ts` forbids a key to do.
 */
const avatars = new Hono<AppEnv>();

const TOO_LARGE = { error: "photo too large (max 2 MB)" };

/**
 * Deletes an object the profile no longer points at, without failing the
 * request: the profile is already right, and a leftover object is a storage
 * cost the log can name, not something the person can do anything about.
 */
async function forget(env: AppEnv["Bindings"], key: string | null, why: string) {
  if (!key) return;
  try {
    await getDocStore(env).delete(key);
  } catch (e) {
    console.error(`avatar: ${why}`, key, e);
  }
}

/** The caller's current `avatar_url`, read so the object behind it can go. */
async function currentAvatarKey(db: AppEnv["Variables"]["db"], userId: string) {
  const { data } = await db.from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
  return avatarKeyFromUrl((data?.avatar_url as string | null | undefined) ?? null, userId);
}

// PUT /me/avatar — multipart `file`; PNG, JPEG or WebP, at most 2 MB.
avatars.put("/me/avatar", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  // Refused before the body is read, when the client says how big it is. The
  // check after parsing is the one that counts; this one saves parsing 50 MB to
  // find out.
  const contentLength = parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > AVATAR_MAX_BYTES + 64 * 1024) {
    return c.json(TOO_LARGE, 413);
  }

  const body = await c.req.parseBody().catch(() => null);
  const file = body?.["file"];
  if (!(file instanceof File)) return c.json({ error: "no photo provided" }, 400);
  if (file.size === 0) return c.json({ error: "empty file" }, 400);
  if (file.size > AVATAR_MAX_BYTES) return c.json(TOO_LARGE, 413);

  // Decided from the bytes; `file.type` and the file name are the client's say.
  const bytes = await file.arrayBuffer();
  const type = sniffImage(new Uint8Array(bytes));
  if (!type) return c.json({ error: "only PNG, JPEG or WebP photos" }, 415);

  const previous = await currentAvatarKey(db, user.id);

  const key = avatarKey(user.id, type);
  try {
    await getDocStore(c.env).put(key, bytes, { contentType: type });
  } catch (e) {
    console.error("avatar: failed to store", e);
    return c.json({ error: "failed to store the photo" }, 500);
  }

  const { data: updated, error } = await db
    .from("profiles")
    .update({ avatar_url: avatarPath(key) })
    .eq("id", user.id)
    .select(PROFILE_COLUMNS);

  // Zero rows is RLS refusing, and the object just written belongs to no row:
  // take it back rather than leave an orphan the account erasure cannot find.
  if (error || !updated || updated.length === 0) {
    if (error) console.error("avatar: profile update failed", error);
    await forget(c.env, key, "rollback failed");
    return c.json({ error: "failed to save your photo" }, 500);
  }

  if (previous && previous !== key) await forget(c.env, previous, "old photo not removed");

  return c.json(mapProfile(updated[0] as ProfileRow, user.email));
});

// DELETE /me/avatar — back to initials.
avatars.delete("/me/avatar", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const previous = await currentAvatarKey(db, user.id);

  const { data: updated, error } = await db
    .from("profiles")
    .update({ avatar_url: null })
    .eq("id", user.id)
    .select(PROFILE_COLUMNS);

  if (error || !updated || updated.length === 0) {
    if (error) console.error("avatar: profile update failed", error);
    return c.json({ error: "failed to remove your photo" }, 500);
  }

  // Deleted rather than merely unlinked, so "Remove" means the old URL stops
  // working for anybody who kept it.
  await forget(c.env, previous, "removed photo not deleted");

  return c.json(mapProfile(updated[0] as ProfileRow, user.email));
});

/**
 * GET /avatars/:userId/:file — the photo itself, to anybody holding the URL.
 *
 * Unauthenticated because an `<img>` sends no bearer token. What stands in for
 * a caller is the URL: 128 random bits in the file name, handed out only to the
 * people `profiles` already shows the row to, and dead the moment the photo is
 * replaced or removed.
 *
 * Both parameters are checked against the exact shapes `avatarKey` produces
 * before the store is touched, and the key is rebuilt from those checked parts
 * rather than from the raw path, so no request can steer a read anywhere else
 * in the store — not into another prefix, and not into somebody's documents.
 * The Content-Type comes from the checked extension, never from the object.
 *
 * `immutable` is honest: a new upload is a new key, and the old one is deleted.
 * The sandbox CSP and `nosniff` are for the browser that opens the URL as a
 * page rather than as an image — the sniffed signature already makes it a
 * picture, and these make sure nothing else would run if it were not.
 */
const avatarsPublic = new Hono<AppEnv>();

avatarsPublic.get("/avatars/:userId/:file", async (c) => {
  const userId = c.req.param("userId");
  const file = c.req.param("file");
  if (!USER_ID_RE.test(userId) || !FILE_RE.test(file)) return c.json({ error: "not found" }, 404);

  const contentType = contentTypeForAvatarFile(file);
  if (!contentType) return c.json({ error: "not found" }, 404);

  const object = await getDocStore(c.env).get(`avatars/${userId}/${file}`);
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

export { avatars, avatarsPublic };
