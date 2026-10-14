import { assetSrc } from "./asset-src";

/**
 * The `<img src>` for a stored `avatar_url`, or null for a monogram.
 *
 * One shape is honoured: `/avatars/<user id>/<32 hex>.<ext>`, a photo uploaded here, served by the
 * API without a token from an unguessable address. Anything else — an
 * `https://` address included — is refused rather than rendered. The column is
 * the user's own to write, and an image on somebody else's server, loaded by
 * every co-member's member list, tells that server who looked and when. The
 * database refuses those values too (0095); this is the same rule on the side
 * that would have made the request.
 */
const STORED =
  /^\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{32}\.(png|jpg|webp)$/;

export function avatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  return STORED.test(url) ? assetSrc(url) : null;
}
