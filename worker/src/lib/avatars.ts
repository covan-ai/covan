/**
 * Uploaded profile photos: what may be stored, where, and how to find it again.
 *
 * A photo lives in the document store (`lib/docstore`) under
 * `avatars/<user id>/<32 random hex>.<ext>`, and `profiles.avatar_url` holds the
 * API path that serves it, `/avatars/<user id>/<file>`. Why the bytes are not in
 * the database is written at the top of `0082_a_face_a_sentence_and_a_clock.sql`.
 *
 * The serving route is unauthenticated, because an `<img>` cannot send a bearer
 * token, so the URL is a capability: 128 random bits nobody can guess, served
 * only to the people `profiles` already shows it to. Everything here is pure, so
 * the rules that make that safe can be tested without a request.
 */

/**
 * The largest photo the API will store.
 *
 * The account page resizes to 256 px before uploading, which lands well under
 * 100 KB; this is the ceiling for a client that skipped that step, not a size
 * anybody is expected to approach.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

const EXTENSION: Record<AvatarType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const TYPE_FOR_EXTENSION: Record<string, AvatarType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** A user id as Postgres spells a uuid: lowercase, hyphenated. */
export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stored photo's file name: exactly what `avatarKey` generates, nothing else. */
export const FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp)$/;

/**
 * What the bytes are, read from the bytes.
 *
 * The client's `file.type` and the file's name are both whatever the client
 * said, and a photo is served back to every co-member's browser — so the type
 * is decided here, from the signature at the start of the file, and anything
 * that is not one of the three is refused. SVG in particular is refused rather
 * than sanitised: it is a document that can carry script, not a picture.
 */
export function sniffImage(bytes: Uint8Array): AvatarType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // RIFF....WEBP: the four bytes in between are the chunk size.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * A fresh store key for a photo.
 *
 * New on every upload, never reused: that is what lets the serving route call
 * the response immutable, and what makes the URL unguessable. The user id in
 * the path is for whoever reads the store, not a secret.
 */
export function avatarKey(userId: string, type: AvatarType): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
  return `avatars/${userId}/${hex}.${EXTENSION[type]}`;
}

/** What `profiles.avatar_url` stores for a key: the path the API serves it at. */
export function avatarPath(key: string): string {
  return `/${key}`;
}

/**
 * The store key behind an `avatar_url`, or null when the URL is not one of ours.
 *
 * An absolute URL is a provider's photo and there is nothing of ours to delete;
 * anything that does not match the exact shape `avatarPath` produces is treated
 * the same way, because this answer decides what gets deleted from the store,
 * and a key built from a looser match is a delete somebody else steered.
 */
export function avatarKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^\/avatars\/([^/]+)\/([^/]+)$/.exec(url);
  if (!match) return null;
  const [, userId, file] = match;
  if (!USER_ID_RE.test(userId) || !FILE_RE.test(file)) return null;
  return `avatars/${userId}/${file}`;
}

/**
 * The Content-Type to serve a stored file with, from its validated extension.
 *
 * Never from the object's own recorded type: the extension was chosen by
 * `avatarKey` from sniffed bytes, and it is the one thing about the request
 * already checked against `FILE_RE`.
 */
export function contentTypeForAvatarFile(file: string): AvatarType | null {
  if (!FILE_RE.test(file)) return null;
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return TYPE_FOR_EXTENSION[ext] ?? null;
}
