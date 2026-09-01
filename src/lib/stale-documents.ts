import { documentAge, STALE_AFTER_DAYS } from "./relative-time";

/**
 * Which documents are worth going back to, and in what order.
 *
 * The two facts on their own are not useful. A document that is nine months old
 * and grounds no answers is nobody's problem — it sits in a bundle and nothing
 * asks it anything. A document that grounds forty answers and was uploaded last
 * week is working exactly as intended. It is the pair that matters, and the
 * interface had no way to show a pair.
 *
 * So: old enough to doubt, and used enough to matter. Both, or it does not
 * appear here.
 *
 * Ordered by how many answers stand on it, not by age. Age decides whether a
 * document is a candidate; the count decides which candidate to fix first,
 * because that is the one whose staleness has reached the most people. An
 * ordering by age would put a two-year-old document with one citation above a
 * ten-month-old one with sixty, which is the opposite of useful.
 */
export type Revisitable = {
  id: string;
  name: string;
  /** How many answers cite it, over the window the caller reports. */
  citations: number;
  /** "9 months ago". */
  age: string;
};

export type CountedDocument = {
  id: string;
  name: string;
  createdAt: number;
};

export function documentsWorthRevisiting(
  documents: CountedDocument[],
  counts: Record<string, number>,
  now: number = Date.now(),
): Revisitable[] {
  return documents
    .map((doc) => ({ doc, age: documentAge(doc.createdAt, now), citations: counts[doc.id] ?? 0 }))
    .filter(({ age, citations }) => age.stale && citations > 0)
    .map(({ doc, age, citations }) => ({
      id: doc.id,
      name: doc.name,
      citations,
      age: age.label,
    }))
    .sort(
      (a, b) =>
        // Citations first. The name is the tie-break rather than the id, so the
        // order is stable and reads as a list somebody arranged — two documents
        // cited the same number of times would otherwise swap places between
        // renders for no reason a reader could see.
        b.citations - a.citations || a.name.localeCompare(b.name),
    );
}

/**
 * One sentence saying what the numbers cover, or null when they cover nothing.
 *
 * Every count is over a window: replies written before citations carried a
 * document id cannot be matched to one at all, so the earliest countable reply
 * is where the numbers begin. Printing "41 answers" without this reads as a
 * total and is a sample — and the gap is largest for exactly the documents this
 * feature is about, the old ones that were being cited long before anything was
 * recording which.
 */
export function countedSince(since: number | null): string | null {
  if (since === null) return null;
  // A date rather than an age. "9 months ago" is the right unit for a document,
  // where the question is how much could have changed; this is a boundary, and
  // a boundary that drifts every time the page is opened is not one a reader
  // can check anything against.
  const on = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
  return `Counting answers since ${on.format(new Date(since))}.`;
}

export { STALE_AFTER_DAYS };
