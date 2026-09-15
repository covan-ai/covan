// Naming a generated report.
//
// The model is asked to open with a single `# ` title, and the filename comes
// from that line rather than from a second call: a report that has just been
// written already contains the best short description of itself anybody is
// going to produce, and paying a titling call for it — the way a chat session
// does in `lib/session-title.ts` — would buy nothing the output does not
// already carry.

/**
 * How long a title may be before it stops being a filename.
 *
 * Wider than the 60 characters `session-title.ts` allows, because a title in
 * the sidebar is read at a glance in a narrow column and this one is read as a
 * document name in a list that has the width for it. Still a cap: a model that
 * answers the instruction with a paragraph under a `#` would otherwise name a
 * file with it.
 */
export const REPORT_TITLE_MAX_CHARS = 80;

// Leading spaces are tolerated (markdown allows up to three before a heading),
// and so is any heading level. The instruction asks for `#`; a model that
// answers with `##` has still named the report, and throwing that away for one
// extra hash would swap a title somebody can read for a dated placeholder.
const HEADING = /^\s{0,3}#{1,6}[ \t]+(.+)$/m;

/**
 * The report's own title, or null when the output names nothing.
 *
 * Null is a real answer and not a failure — the caller has a dated fallback,
 * and anything the model wrote is still saved under it.
 */
export function reportTitle(markdown: string): string | null {
  const match = markdown.match(HEADING);
  if (!match) return null;

  const title = match[1].replace(/\s+/g, " ").trim().slice(0, REPORT_TITLE_MAX_CHARS);
  return title.length > 0 ? title : null;
}

/**
 * What the document row is called.
 *
 * Deliberately not sanitised. This is `documents.name`, which is what a person
 * reads in the Knowledge tab — the upload route makes the same split, passing
 * the raw filename to the row and `safeName()` only to the R2 key. Running a
 * title through `safeName` here would turn "Aylık Satış Raporu" into
 * "Ayl_k_Sat__ Raporu" on screen for the sake of an object key nobody sees.
 */
export function reportFileName(title: string | null, today: string): string {
  return `${title ?? `Report ${today}`}.md`;
}
