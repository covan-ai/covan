/**
 * The text a routine run is given to work from, and what it is allowed to cost.
 *
 * WHY THIS FILE EXISTS. These three slices were written twice, verbatim, in
 * `summarise.ts` and `agent-run.ts` — `slice(0, 20_000)` twice and
 * `slice(0, 1_000)` once in each, all four unnamed and uncommented. Two copies
 * of a limit are two limits, and these were the **largest model-visible
 * character bounds in the worker**: five times `MAX_TOOL_OUTPUT_CHARS`, on the
 * one surface with nobody watching the answer.
 *
 * WHAT THEY COST. Measured divisors (`count_tokens`, 2026-09-29, see
 * `0069_what_the_prompt_was_made_of.sql`): dense JSON tokenises at about 2.35
 * characters per token and prose-with-markup at about 1.92. So 20,000 characters
 * of a webhook payload or a watched page is **8,500 to 10,400 tokens** — on its
 * own, more than a whole chat prompt's persona, both manifests, the retrieval
 * block and all eight tool schemas combined. A routine that runs hourly against
 * a page that changes pays that every hour.
 *
 * The values are unchanged and that is deliberate. They bound what the model gets
 * to read before it writes, so moving one is a change to what routines produce
 * and wants evidence about output, not a unit fix. What was missing was anybody
 * being able to see the price — and with two copies, anybody being able to change
 * it in one place.
 */

/**
 * A webhook payload or a watched page, as much of it as the model reads.
 *
 * ~8,500-10,400 tokens at the measured divisors. Third-party text in both cases,
 * which is why it rides in the user message and never in a system one — see
 * `summarise.ts` for that argument at length.
 */
export const MAX_MATERIAL_CHARS = 20_000;

/**
 * One feed item's summary, as much of it as the model reads.
 *
 * ~425-520 tokens each, and unlike the above this one is multiplied: the item
 * count is bounded by `DEFAULT_MAX_PER_RUN` in `feed.ts` and not by anything
 * here, so ten items is ten times this.
 */
export const MAX_ITEM_SUMMARY_CHARS = 1_000;

/** One feed item, as much of it as a prompt needs. */
export type RoutineItem = { title: string; link: string; summary: string };

/**
 * What this run is working from, in the shape both model-calling routine paths
 * want it.
 *
 * The order is the precedence and it was the same in both copies: a poke's
 * payload beats a watched page beats the feed items, because a run has at most
 * one of the three and the branch is which kind of run this is.
 */
export function routineMaterial(input: {
  payloadText?: string;
  pageText?: string;
  items: RoutineItem[];
}): string {
  if (input.payloadText) {
    return `Incoming webhook payload:\n\n${input.payloadText.slice(0, MAX_MATERIAL_CHARS)}`;
  }
  if (input.pageText) {
    return `Watched page content:\n\n${input.pageText.slice(0, MAX_MATERIAL_CHARS)}`;
  }
  return input.items
    .map((i) => `- ${i.title}\n  ${i.link}\n  ${i.summary.slice(0, MAX_ITEM_SUMMARY_CHARS)}`)
    .join("\n\n");
}
