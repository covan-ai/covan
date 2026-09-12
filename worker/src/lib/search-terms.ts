/**
 * Lowercase, with Turkish's four I's collapsed onto one.
 *
 * JavaScript lowercases by Unicode's default rules, not Turkish's: "İ" becomes
 * "i" plus a combining dot (U+0307), and "I" becomes "i" where Turkish would
 * make it "ı". So "İŞE ALIM" lowercases to "i̇şe alim" and stops matching a file
 * called "işe alım.md" — over a letter, in the language half the users type in.
 * Folding i/ı/İ/I together costs nothing here (this is a keyword match, not a
 * display name) and makes all four spellings the same string.
 *
 * Needles are folded with the same function, so both sides agree.
 */
export function fold(value: string): string {
  return value.toLowerCase().replace(/̇/g, "").replace(/ı/g, "i");
}

/**
 * A short token is discriminating only when it carries a digit ("q3", "17",
 * "2024"); a bare two- or three-letter word ("ne", "mi", "bu") is grammar, not
 * a search term, and would only ever match by accident.
 */
const MIN_TERM_LENGTH = 3;

/**
 * Words dropped from a query before it becomes a `tsquery`, Turkish and
 * English mixed because the product is used in both.
 *
 * The lexical arm ORs its terms together (`0049_the_words_as_well_as_the_
 * meaning.sql`), so the cost of a bad term is asymmetric. A rare word that
 * matches nothing costs nothing — it just never contributes a hit. A common
 * one ("what", "nedir", "bir") matches a huge fraction of the corpus and, under
 * OR semantics, drags chunks that have nothing to do with the question into a
 * turn that had no lexical business firing at all. So these are pulled before
 * they ever reach the tsquery, not left for the floor to filter — there is no
 * floor on this arm to filter them.
 *
 * Already folded (lowercase, Turkish ı) so they compare directly against
 * folded tokens.
 */
const STOPWORDS = new Set([
  // Turkish
  "ne",
  "nedir",
  "neydi",
  "nasil",
  "için",
  "bir",
  "bu",
  "mi",
  "ile",
  "var",
  // English
  "what",
  "the",
  "is",
  "how",
  "of",
  "a",
]);

/** Does this token contain at least one digit? */
function hasDigit(token: string): boolean {
  return /\d/.test(token);
}

/**
 * Turns a user's question into the term list the lexical arm's `tsquery`
 * is built from (`p_query_terms` in `match_chunks`).
 *
 * Every step here exists to keep that `tsquery` valid and useful:
 *   - folding agrees with `rag_fold` on the SQL side, so a term folded here
 *     matches the same lexemes `search_tsv` was indexed with;
 *   - splitting is Unicode-aware (`\p{L}` / `\p{N}`, not `[a-z0-9]`) because
 *     folded Turkish text still contains ş, ç, ğ, ö, ü, i;
 *   - short, non-discriminating tokens and stopwords are dropped so an OR'd
 *     tsquery does not fill up with clauses that match half the corpus;
 *   - the result is de-duplicated and capped so a pasted wall of text cannot
 *     turn into a 400-clause tsquery.
 *
 * An empty or greeting-only query returns `[]` by construction — nothing
 * special-cases that, the filtering above just leaves nothing behind — which
 * is what turns the lexical arm off for that turn (`p_query_terms = '{}'`
 * matches no rows, per the migration).
 *
 * The empty-string exclusion below is defensive rather than load-bearing: the
 * length filter already drops anything under `MIN_TERM_LENGTH` characters
 * (an empty string is 0 characters, and 0 has no digit), so no token should
 * reach it. But a term that reaches the SQL side as `""` builds the invalid
 * tsquery token `":*"` and fails the entire retrieval call, not just this
 * arm's contribution to it — so this stays even though nothing above should
 * ever produce one, because "should never happen" is not the same guarantee
 * as "cannot happen" for a bug that turns into a hard failure instead of a
 * degraded result.
 */
export function searchTerms(query: string): string[] {
  const tokens = fold(query).split(/[^\p{L}\p{N}]+/u);

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const token of tokens) {
    if (token === "") continue;
    if (token.length < MIN_TERM_LENGTH && !hasDigit(token)) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;

    seen.add(token);
    terms.push(token);

    if (terms.length === 12) break;
  }

  // Defensive: the checks above should already make an empty string
  // unreachable here, but this array is the last thing standing between a
  // user's question and a `":*"` tsquery token that fails the whole call, so
  // it is asserted rather than assumed.
  return terms.filter((term) => term !== "");
}

/**
 * Whether the lexical (keyword / `tsquery`) search arm runs alongside vector
 * search.
 *
 * Unset (or blank) means on: the lexical arm is meant to run by default, the
 * same way `ragMinSimilarity` (`rag.ts`) defaults its floor rather than
 * requiring every environment to set one. That equivalence matters here for a
 * concrete reason, not just symmetry: an operator who leaves `RAG_LEXICAL` out
 * of their `.env` file gets an empty string from `${RAG_LEXICAL:-}`
 * substitution, not `undefined`, so the empty string has to mean the same
 * thing as unset or every self-hosted deployment that never opted in would
 * fail at boot instead of defaulting to on.
 *
 * A corpus or query shape the lexical arm handles badly does not error when
 * it fires — it just contributes worse-ranked or irrelevant chunks under OR
 * semantics, the same silent-degradation argument `ragMinSimilarity`'s doc
 * comment makes for the similarity floor. So this is a dial an operator can
 * turn off for a corpus (or a language, or a migration rollout) where that
 * trade is not paying for itself, without a deploy that touches code.
 */
export function lexicalSearchEnabled(env: { RAG_LEXICAL?: string }): boolean {
  const raw = (env.RAG_LEXICAL ?? "").trim();
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`RAG_LEXICAL must be "on" or "off" (got ${JSON.stringify(raw)}).`);
}
