import { assetSrc } from "./asset-src";

/**
 * The `<img src>` for a stored `avatar_url`, or null for a monogram.
 *
 * Two shapes are honoured. `/avatars/...` is a photo uploaded here, served by
 * the API without a token from an unguessable address. `https://...` is what an
 * identity provider may have put there at sign-up. Anything else — a `data:`
 * URI, `javascript:`, plain `http:`, a protocol-relative `//host` — is refused
 * rather than rendered: the column is the user's own to write, and an address
 * the app would not have produced is not one it should load into everybody's
 * member list.
 */
export function avatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/avatars/")) return assetSrc(url);
  if (url.startsWith("https://")) return url;
  return null;
}
