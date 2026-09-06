/**
 * Reading `GET /workspace/provider-keys`, which answers two shapes by role.
 *
 * An admin is told the hint — a `hintFor()` fragment such as `sk-…4f2a`.
 * Everybody else is told `true` or `false`: whether the workspace has a key,
 * which is what the wall needs to say "ask your admin", without four characters
 * of a live credential going to somebody whose business it is not.
 *
 * Truthiness answers "is a key set" for either shape, so only the code that
 * actually renders the fragment needs the function below. Its own module rather
 * than `api-client.ts` so a test can keep it real while mocking every request
 * beside it — importing `api-client` for one pure function pulls the Supabase
 * client in with it.
 */

/** The displayable hint, or null where we were only told that one exists. */
export function keyHint(value: string | boolean | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}
