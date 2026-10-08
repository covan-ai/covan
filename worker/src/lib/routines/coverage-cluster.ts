import { normaliseForComparison } from "../rag";

/**
 * The guard between a private question and an admin's inbox.
 *
 * Everything here is pure. No model, no database, no network — on purpose,
 * because the alternative was a prompt that asks a model not to report a
 * cluster of one and not to quote anybody, and a prompt is a request. These
 * functions run on what the model sent back, so a model that ignores its
 * instructions produces a report that says LESS rather than a disclosure:
 * clusters it should not have sent are dropped, and labels it should not have
 * written are withheld while the topic underneath them is still counted.
 *
 * covan-ai/covan#44 is the issue; `0053`'s header is the argument about why the
 * counts could ship without any of this and the questions behind them could
 * not.
 */

/** One sub-floor question, as `workspace_coverage_gaps` returns it. */
export type GapQuestion = {
  /** Already truncated to 120 characters by the function. */
  question: string;
  /**
   * An opaque integer, stable only within one call of the function.
   *
   * Never a user id — the function does not return one. It exists so the floor
   * can be counted here without anybody's identity reaching this process.
   */
  askerKey: number;
};

export type DedupedQuestion = {
  question: string;
  askerKeys: Set<number>;
  /** How many times it was asked, which is what the report prints. */
  copies: number;
};

/** What the model answered: a label, and which deduped questions it covers. */
export type RawCluster = { label: string; members: number[] };

/**
 * A gap that survived. The only shape the renderer ever sees.
 *
 * `label` is `null` when the containment check refused to name the topic. The
 * row is no less real for it: at least the floor's worth of different people
 * asked about this, the counts are the counts, and the admin is told the topic
 * is there. What is withheld is the name the model gave it, because that name
 * reproduced somebody's question.
 *
 * Deliberately `null` rather than a display string like `"(topic withheld)"`.
 * How a refusal should read to an admin is the renderer's decision
 * (`coverage-render.ts`), and a sentinel string in the data is one that gets
 * reworded, localised, sorted as a label, or — the real risk — read as a
 * topic name. `null` cannot be mistaken for a topic.
 */
export type Gap = { label: string | null; questions: number; askers: number };

/**
 * The longest a topic label may be.
 *
 * A label is a few words naming an area of the team's work. A model that
 * returns a paragraph has either misunderstood or is quoting, and both are
 * answered the same way: cut it. 80 characters is long enough for the longest
 * reasonable one and far too short to hide a question in.
 */
export const MAX_LABEL_CHARS = 80;

/**
 * How many distinct askers a cluster needs before it may be reported.
 *
 * Derived from the workspace's size rather than configured, because what the
 * floor protects is members from each other:
 *
 *   1 member   → 1. There is nobody to protect from. The only person who could
 *                read the report is the only person who asked, and a floor here
 *                would fail a solo founder for a protection nobody needs.
 *   2 members  → null, meaning do not run. With two people ANY reported topic
 *                tells one of them about the other; k-anonymity is impossible
 *                at n=2 and no number fixes it. The interface says so at the
 *                switch (`GAP_REPORT_MIN_MEMBERS` in `src/lib/routine-templates.ts`)
 *                so nobody has to discover it from an empty report every week.
 *   3 or more  → 3.
 *
 * Not configurable in any form. A privacy floor an admin can set is a privacy
 * floor an admin can set to one.
 *
 * A member count that is not a positive integer answers null — unavailable
 * rather than unguarded, which is the only safe direction for a function whose
 * answer decides what gets disclosed.
 */
export function askerFloor(memberCount: number): number | null {
  if (!Number.isInteger(memberCount) || memberCount < 1) return null;
  if (memberCount === 1) return 1;
  if (memberCount === 2) return null;
  return 3;
}

/**
 * Collapse questions that are literally the same question.
 *
 * On a real workspace the same thing is asked over and over, and fifty copies
 * of "how do I expense a flight" is one gap rather than fifty. Doing this
 * before the model call is also the only token saving in this feature that
 * costs nothing: the prompt is the whole of what a run pays for.
 *
 * Containment on normalised text, not similarity, and `normaliseForComparison`
 * is `rag.ts`'s — whitespace and case, nothing else. "Nearly the same question"
 * is a judgement this must not make on its own: merging two questions that
 * differ in meaning would put one person's topic under another's label.
 *
 * **Every copy's asker key is kept.** Two people asking the same thing is two
 * askers behind one gap, and a dedupe that kept one would silently lower the
 * floor — the one change in this feature that weakens a guarantee while looking
 * like an optimisation.
 */
export function dedupeQuestions(rows: GapQuestion[]): DedupedQuestion[] {
  const byText = new Map<string, DedupedQuestion>();

  for (const row of rows) {
    const key = normaliseForComparison(row.question);
    if (key === "") continue;

    const existing = byText.get(key);
    if (existing) {
      existing.askerKeys.add(row.askerKey);
      existing.copies += 1;
    } else {
      byText.set(key, {
        question: row.question,
        askerKeys: new Set([row.askerKey]),
        copies: 1,
      });
    }
  }

  return [...byText.values()];
}

/**
 * How much of a question a label may reproduce before it stops naming a
 * topic and starts quoting an answer.
 *
 * Any one of the three is enough on its own: `QUOTATION_MIN_WORDS` words,
 * `QUOTATION_MIN_CHARS` characters, or sharing `QUOTATION_MIN_RATIO` of the
 * question's own words with it. Below all three, the shared text cannot
 * carry both a subject and a predicate — three words under forty characters
 * that are also under 60% of the question is a noun phrase, which is what a
 * topic label is. The floor already requires three independent askers behind
 * anything that reaches this check, so a phrase that survives it is one
 * three people raised on their own, not one lifted word for word out of a
 * single person's mouth.
 *
 * A review of the single-expression version this replaced ran it over
 * thirteen realistic label/question pairs and found it drops eleven of them
 * — including `"Expense policy"` and `"Parental leave"`, the exact multi-word
 * phrases colleagues use to ask about those subjects — while keeping
 * `"Expenses"` and dropping `"Expense"` against the same question, a result
 * that turns on whether the model pluralised a noun. These thresholds are
 * the fix: a rule that can tell a topic name from a quoted question apart.
 */
const QUOTATION_MIN_WORDS = 4;
const QUOTATION_MIN_CHARS = 40;
const QUOTATION_MIN_RATIO = 0.6;

/**
 * Split into word-ish tokens: runs of letters and digits, case-folded.
 * Punctuation, whitespace and everything else is a separator and is
 * discarded rather than preserved.
 *
 * Fix round 2: the previous version of this check matched on a regex word
 * boundary (`\b`), which depends on there being a transition between a word
 * character and a non-word one. A needle that itself ends in punctuation —
 * almost every real question does, with "?" — can leave both sides of that
 * transition non-word, so the boundary, and the match, never fired. That
 * silently defeated Direction B below on the common case rather than the
 * edge case. Tokenising first and comparing token arrays has no boundary to
 * fail: punctuation is gone before the comparison runs, so
 * `"expense a flight?"` and `"expense a flight"` tokenise identically.
 *
 * This errs toward matching, not away from it: `"don't"` tokenises as
 * `["don", "t"]`, so a contraction's halves can each match on their own.
 * That is the safe direction here — Direction B is unconditional, and
 * Direction A is still gated by the three thresholds below, so a little
 * extra matching costs a few more borderline topic labels rejected, never a
 * question let through.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** Does `needle` appear as a contiguous run inside `haystack`, token for
 * token? Tokens never contain the delimiter, so joining each array with a
 * single space and checking that one joined string contains the other,
 * space-bounded, is exact — no partial-token match is possible. */
function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  return ` ${haystack.join(" ")} `.includes(` ${needle.join(" ")} `);
}

/**
 * Is `label` a quotation of one of `questions`, rather than a name for one?
 *
 * **What a `true` here costs, and why that is the whole design.** It does not
 * delete the gap. `enforceFloor` answers it by emitting the row with no label
 * at all, which is the one thing that lets this function stop being tuned.
 * For five fix rounds one boolean was asked to decide two separate questions
 * — may this topic be reported, and may it be named — and because firing
 * deleted the row, every adjustment traded an admin's missing gap against a
 * colleague's leaked question. There is no setting that is right for both.
 * Split, each half is easy: the floor above decides reporting, this decides
 * naming, and this one can be as absolute as it likes because the worst a
 * false positive now does is leave a topic nameless.
 *
 * Two different events, deliberately never one expression again:
 *
 *   * Direction B — the label embeds a whole question. Absolute, and with no
 *     threshold of any kind: there is no length at which reproducing
 *     somebody's question verbatim stops being the disclosure. Checked two
 *     ways: as a token sequence, and — fix round 3 — as a raw substring on
 *     the normalised text. The token check alone misses a question glued onto
 *     a label with no separator at the seam: `tokenise` has no word/non-word
 *     transition to split on inside a run of Japanese, Chinese or Thai
 *     characters, so the whole glued run becomes ONE token, which is a
 *     superstring of the question's own token rather than a sequence
 *     containing it — exactly what `containsTokenSequence` exists to refuse.
 *     The raw-substring check restores what this guard did for B before
 *     tokenising replaced it, but only for B: it can only ever ADD a refusal
 *     here, which is the safe direction for an absolute check, and it never
 *     reaches Direction A.
 *
 *     Fix round 5 put a five-character floor on the needle, because a match
 *     deleted the row and a junk `"hi"` question therefore deleted every
 *     label with those two letters anywhere in it. Fix round 6 took the floor
 *     back out, and it is not coming back. Four characters in a script with
 *     no inter-word separators is not a topic word — it is a complete
 *     first-person sentence. `"我怀孕了"` is "I'm pregnant"; `"我要辞职"` is
 *     "I want to resign"; the same length says as much in Japanese and
 *     Korean. Measured: with the floor in place, a label wrapping any of
 *     those reached the admin's inbox verbatim. The floor is gone and so is
 *     the reason it existed — a false positive here now costs a topic's NAME
 *     and not the topic, so this half needs no length, no script table and no
 *     word-boundary argument to be safe in either direction. That is the
 *     trade, stated plainly: a junk question can leave a real topic nameless,
 *     and a nameless topic an admin can see beats a deleted one they cannot.
 *   * Direction A — a question embeds the label. Only a quotation once the
 *     shared run of words clears `QUOTATION_MIN_WORDS`, `QUOTATION_MIN_CHARS`
 *     or `QUOTATION_MIN_RATIO` — see that constant's comment for why those
 *     three and not a flat containment check. Token sequence only, never
 *     raw substring: that is what let a one-word label survive appearing
 *     inside a longer, unrelated word (`"ai"` inside `"email"`), the defect
 *     that split this rule from one expression into two in the first place.
 *
 * The word counts the Direction A thresholds read are lengths of the same
 * token arrays `containsTokenSequence` matched on, not a separately computed
 * word count — so the counting and the matching cannot disagree with each
 * other about what a "word" is.
 */
function isQuotation(label: string, questions: DedupedQuestion[]): boolean {
  const labelTokens = tokenise(label);
  if (labelTokens.length === 0) return false;
  const normalisedLabel = normaliseForComparison(label);

  return questions.some((q) => {
    const qTokens = tokenise(q.question);
    if (qTokens.length === 0) return false;
    const normalisedQuestion = normaliseForComparison(q.question);

    if (containsTokenSequence(labelTokens, qTokens)) return true;
    if (normalisedLabel.includes(normalisedQuestion)) return true;

    if (!containsTokenSequence(qTokens, labelTokens)) return false;
    return (
      labelTokens.length >= QUOTATION_MIN_WORDS ||
      normalisedLabel.length >= QUOTATION_MIN_CHARS ||
      labelTokens.length / qTokens.length >= QUOTATION_MIN_RATIO
    );
  });
}

/**
 * Slice to `MAX_LABEL_CHARS` by Unicode code point, not UTF-16 unit.
 *
 * `label.slice(0, N)` counts UTF-16 units, so a label truncated in the middle
 * of an emoji (or anything else outside the Basic Multilingual Plane) leaves
 * a lone surrogate behind — a string that is not valid UTF-16, which breaks
 * an email renderer or a JSON payload rather than merely looking cut off.
 *
 * Fix round 5: trimmed again afterwards. The caller trims before truncating,
 * which says nothing about the end of the *prefix* — a label padded with
 * whitespace in the middle was reported as a word followed by seventy-nine
 * spaces. Only the end needs it: the string arrives already trimmed, so the
 * prefix can never begin with whitespace.
 */
function truncateLabel(label: string): string {
  return [...label].slice(0, MAX_LABEL_CHARS).join("").trimEnd();
}

/**
 * Keep only the clusters that may be reported, and say how big each one is.
 *
 * Refuses seven things a model, or a caller, can hand it — each one a way a
 * disclosure or a broken report would reach an admin without anybody having
 * chosen it. Every one of them is a drop but one. **The exception:** a label
 * that quotes a question is withheld, and the row goes out with `label: null`
 * rather than not going out at all. Reporting and naming are two decisions
 * (see `isQuotation`), and a dropped row is also indistinguishable from a
 * quiet week — so the refusal that fires on a judgement call is the one that
 * keeps the fact and loses the name.
 *
 *   * a floor that is not a positive integer. `askerFloor` already answers
 *     `null` for exactly this input; refusing it again here closes the gap a
 *     caller would otherwise hit at the type checker and paper over with
 *     `floor ?? 0` — which this function would satisfy for every cluster,
 *     since a count can never be less than zero. The function that computes
 *     the floor refuses garbage; this one must too, or the refusal is only
 *     theatre at one end of the call.
 *   * fewer distinct askers than the floor — the floor itself.
 *   * a repeated member index — de-duplicated before counting, so a model
 *     repeating an index cannot inflate a gap's count and promote it.
 *   * a member index that is not in the list — a model counting past the end.
 *   * a label that quotes a question, per `isQuotation` — the one refusal
 *     that keeps the row. Checked against every question the model saw
 *     (`deduped`), not just this cluster's own members, because a quoted
 *     question is the same disclosure whichever cluster it was filed under;
 *     and checked against the label both before and after truncation,
 *     because truncating first can cut a quote in half and let the surviving
 *     half through. The gap is emitted with `label: null` and the renderer
 *     prints the refusal.
 *   * a label that is empty, whitespace, or longer than `MAX_LABEL_CHARS` —
 *     the last of these is truncated rather than dropped, since a long label
 *     is usually a correct label with an explanation glued on.
 *   * a label with no letter or digit in it at all — "???!!!" or an emoji
 *     string trims to something non-empty and tokenises to nothing, which
 *     `isQuotation` would otherwise call "not a quotation" for lack of
 *     anything to compare. Not a disclosure, but a blank-looking bullet in
 *     the admin's email, which the renderer must never emit. Asked of the
 *     label *after* truncation, because that is the one the report prints:
 *     a label whose only letters fall past `MAX_LABEL_CHARS` has them cut
 *     off before anybody reads it, and the eighty characters that are left
 *     are the punctuation.
 *
 * Ordered by how many questions are behind the gap, so the thing most worth
 * writing down is first. That is `0053`'s ordering choice for its own pair of
 * functions, made again here.
 *
 * A thin wrapper over `enforceFloorWithCoverage` — see that function for the
 * loop. Kept as its own export, with this exact signature, so that every
 * caller and this file's own suite see no change: a `Gap[]` in, a `Gap[]`
 * out, same as before Task 12 added the function beside it.
 */
export function enforceFloor(
  clusters: RawCluster[],
  deduped: DedupedQuestion[],
  floor: number | null,
): Gap[] {
  return enforceFloorWithCoverage(clusters, deduped, floor).gaps;
}

/** `enforceFloor`'s `Gap[]`, plus how much of `deduped` it accounts for. */
export type FloorResult = {
  gaps: Gap[];
  /**
   * How many of `deduped`'s DISTINCT questions belong to a cluster that
   * survived — i.e. that this call actually pushed into `gaps`. Never a
   * count of copies (that is `Gap.questions`, a sum) and never a count of
   * gaps: a `Gap` can bundle several deduped questions, and this counts the
   * questions, once each, regardless of how many gaps they ended up under or
   * how many times any one of them was asked.
   *
   * A label withheld as a quotation (`label: null`) still counts its members
   * as covered — the row survived the floor and was pushed; only its name
   * was withheld. Everything else contributes nothing, for any of three
   * reasons, not only the one below the floor: a question the model never
   * put in any cluster at all, a cluster that had too few distinct askers,
   * and a cluster refused outright on label grounds (empty, unreadable, or
   * nothing but punctuation) before a `Gap` was ever built for it. Fix round
   * 1, finding 3: `coverage-render.ts`'s rendered sentence for `withheld`
   * used to name only the floor as the cause, and `coverage-source.test.ts`'s
   * duplicates-and-shortfall case has seven withheld questions that were
   * never clustered at all — the floor was never the reason for those seven.
   *
   * `deduped.length - coveredCount` is a count of distinct questions that no
   * surviving gap covers — Task 12's `withheld`, and `coverage-render.ts`'s
   * docblock for the field of the same name. That subtraction has to be done
   * against THIS number and not against `Σ Gap.questions`: the latter counts
   * copies, so one repeated question inside a surviving cluster can make it
   * exceed `deduped.length` and send the subtraction negative — exactly the
   * defect Task 12's brief shipped and this export exists to avoid, by
   * handing back a count that is already in the right unit.
   */
  coveredCount: number;
};

/**
 * `enforceFloor`'s own loop, read twice over rather than walked twice.
 *
 * Exists because the question "how many distinct questions does this NOT
 * cover" can only be answered correctly by the same resolution that decides
 * which clusters survive — member de-duplication, the range filter, and the
 * floor and label refusals all have to agree with `enforceFloor` about which
 * clusters counted, or the two numbers drift the moment one side's rules
 * change and the other's do not. So this is the one place that walk happens;
 * `enforceFloor` above is now a view onto it, and `coverage-source.ts` calls
 * this directly rather than re-deriving coverage from `Gap[]` alone, which
 * carries no member indices to re-derive it from.
 */
export function enforceFloorWithCoverage(
  clusters: RawCluster[],
  deduped: DedupedQuestion[],
  floor: number | null,
): FloorResult {
  if (floor === null || !Number.isInteger(floor) || floor < 1) {
    return { gaps: [], coveredCount: 0 };
  }

  const gaps: Gap[] = [];
  const covered = new Set<number>();

  for (const cluster of clusters) {
    // De-duplicated before the range filter: a model repeating an index must
    // not get to count that question's askers and copies more than once.
    // Indices are kept alongside the resolved rows — rather than mapped away
    // immediately, as the single-return version of this loop once did —
    // because `covered` below needs them and `Gap` does not carry them.
    const memberIndices = [...new Set(cluster.members)].filter(
      (i) => Number.isInteger(i) && i >= 0 && i < deduped.length,
    );
    if (memberIndices.length === 0) continue;
    const members = memberIndices.map((i) => deduped[i]);

    const askers = new Set<number>();
    let questions = 0;
    for (const m of members) {
      for (const k of m.askerKeys) askers.add(k);
      questions += m.copies;
    }
    if (askers.size < floor) continue;

    const fullLabel = cluster.label.trim();
    if (fullLabel === "") continue;

    const truncatedLabel = truncateLabel(fullLabel);

    // A label can be non-empty and still carry no letter or digit — "???!!!"
    // or an emoji string both trim to something, and `isQuotation` would
    // call either "not a quotation" (there is nothing to compare), so this
    // has to be its own refusal rather than falling out of that check.
    //
    // Fix round 4: asked of `truncatedLabel`, which is the value this
    // function pushes, and not of `fullLabel`, which it does not. A label
    // whose only letters fall past `MAX_LABEL_CHARS` — eighty exclamation
    // marks and then a topic — has tokens in the full string and none in the
    // eighty characters an admin actually reads, so asking the full string
    // passed it and the report printed a row of punctuation. Asking the
    // emitted value is also strictly the stronger of the two: the truncated
    // label is a prefix of the full one, so every letter or digit in the
    // prefix is one in the whole, and nothing the full string would have
    // refused gets through here.
    if (tokenise(truncatedLabel).length === 0) continue;

    // Everything past this line survives — named or not — so its members are
    // covered either way. Set before the naming decision below, which only
    // ever changes what a surviving row is called, never whether it counts.
    for (const i of memberIndices) covered.add(i);

    // Both the label as the model wrote it and the label as the report will
    // show it, against every question the model saw — not just this
    // cluster's members. See `enforceFloor`'s own comment for why each half
    // of this matters on its own.
    //
    // Fix round 6: emitted without a name, not dropped. Deliberately NOT a
    // `continue` — everything above this line is, and that difference is the
    // amendment. The floor has already decided this cluster may be reported;
    // all that is in doubt here is whether the model's name for it may be
    // printed, and the answer to that doubt should not take an admin's gap
    // with it. `truncatedLabel` is computed and then thrown away on this
    // path: it was needed for the check, never for the output.
    if (isQuotation(fullLabel, deduped) || isQuotation(truncatedLabel, deduped)) {
      gaps.push({ label: null, questions, askers: askers.size });
      continue;
    }

    gaps.push({ label: truncatedLabel, questions, askers: askers.size });
  }

  // `questions` descending, then named rows before unnamed ones — which
  // keeps a report's list reading as topics first and refusals after — and
  // then the labels in code-unit order.
  //
  // Deliberately not `localeCompare`. A collator with no locale argument is
  // scoped to the host's locale and ICU data, so the same two labels can come
  // out in a different order on two machines; the renderer's promise of a
  // byte-identical report for byte-identical input rests on this comparator,
  // and a promise that depends on where the worker ran is not one. The
  // consequence is owned rather than hidden: `"Banana"` sorts before
  // `"apple"`, because uppercase letters are lower code units. That is only
  // ever a tie-break between gaps with the same question count.
  //
  // Not a total order, and it does not need to be: two rows that tie on all
  // three keys keep the order they arrived in, which `Array.prototype.sort`
  // guarantees by being specified as stable. The ordering is therefore a
  // function of the input alone.
  gaps.sort((a, b) => {
    if (a.questions !== b.questions) return b.questions - a.questions;
    if (a.label === null || b.label === null) {
      if (a.label === b.label) return 0;
      return a.label === null ? 1 : -1;
    }
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  return { gaps, coveredCount: covered.size };
}
