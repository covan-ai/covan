/**
 * An `<img src>` for something this API serves without a token.
 *
 * The reason it needs a helper at all is that `request()` cannot be it: an
 * `<img>` sends no `Authorization` header, so the address has to be built
 * rather than fetched. Its callers are the toolkit logo and a person's avatar,
 * and what comes back from the API for either is a path and never a
 * third-party URL, so this cannot be pointed off-origin by anything the API
 * says — see `allowedLogoUrl` in the worker for the logo's other half, and
 * `avatarSrc` for the avatar's.
 */
export function assetSrc(path: string): string {
  return path ? `${import.meta.env.VITE_API_URL}${path}` : "";
}
