/**
 * Where the documentation lives, stated once.
 *
 * `docs/` in this repository holds the markdown files that answer the
 * questions people actually arrive with — what a bundle is, why a question
 * found the passage it did, what a role gates — and until now nothing in the
 * application linked to any of them. Two thousand lines of good writing, and
 * the only way to find it was to already know it existed.
 *
 * The pages are rendered at covan.app/docs, one URL per file, with the slug
 * being the filename without its extension. That shape belongs to the site
 * rather than to this build, which is exactly why it is written down in one
 * place here: a rename over there breaks every one of these links, and
 * `docs.test.ts` is the tripwire for the half of that this repository can see.
 */

const BASE = "https://covan.app/docs";

/**
 * The slug of every page linked from the interface. Named rather than free
 * strings so the test can check them against `docs/`, and so a typo is a
 * compile error instead of a 404 somebody finds later.
 */
export const DOC_SLUGS = [
  "quickstart",
  "concepts",
  "knowledge",
  "routines",
  "integrations",
  "team",
  "api",
  "self-hosting",
  "architecture",
] as const;

export type DocSlug = (typeof DOC_SLUGS)[number];

/** The index, for a link that means "the documentation" rather than one page. */
export const DOCS_HOME = BASE;

export function docsUrl(slug: DocSlug): string {
  return `${BASE}/${slug}`;
}
