import { quoteOf, type Entitlements } from "../entitlements";

/**
 * What a paid run may spend, sent as its `maxCostUsd`.
 *
 * A paid run carried a flat $0.25 until 2026-10-24, and a run asked to look
 * through several sites reached it and ended with no answer — the person
 * paid for every page it read and got an error. The flat ceiling came off;
 * these two bounds are what replaced it, and neither is about a typical task,
 * which costs two to six cents:
 *
 * - **What the workspace can pay for.** Credits are charged when a run ends,
 *   at the provider's own figure, so a run started on the last few credits
 *   could otherwise spend many times the balance — the overshoot landing on
 *   the operator. The ceiling is the provider cost the balance above the
 *   floor still covers, converted by the hosted build's own `quote`, so the
 *   rate never crosses into this tree.
 * - **A runaway.** A run that loops — a page that never settles, a step it
 *   repeats — has nothing else to stop it but the provider's timeout and the
 *   sweep. `RUNAWAY_COST_CAP_USD` is far above any task seen, and it is the
 *   only bound on a self-hosted install and a house workspace, where nobody
 *   is metered and the deployment's own key pays.
 */

/** A run that reaches this has gone wrong, not run long. Some eighty typical tasks. */
export const RUNAWAY_COST_CAP_USD = 5;

/**
 * Below this, the run is told its budget is small (`CAPPED_RUN_PREAMBLE`), so
 * it reports what it has rather than running into the ceiling with no answer.
 */
export const TIGHT_CEILING_USD = 0.5;

/** The provider wants a positive ceiling; a cent still lets a run say what it saw. */
const MIN_CEILING_USD = 0.01;

/**
 * The ceiling for a paid run in `workspaceId`.
 *
 * Never refuses: whether the run may start at all is `check`'s question,
 * asked before this. A snapshot that cannot be read, or a deployment with no
 * `quote`, gets the runaway ceiling alone — the same answer an unmetered
 * install gets, and the one that loses nobody an answer.
 */
export async function paidRunCeiling(
  entitlements: Pick<Entitlements, "snapshot" | "quote">,
  workspaceId: string,
): Promise<number> {
  try {
    const credits = await entitlements.snapshot(workspaceId);
    const quote = quoteOf(entitlements);
    if (!credits.metered || credits.unlimited || !quote) return RUNAWAY_COST_CAP_USD;
    const perUsd = quote(1);
    if (!Number.isFinite(perUsd) || perUsd <= 0) return RUNAWAY_COST_CAP_USD;
    const affordable = (credits.balance - (credits.floor ?? 0)) / perUsd;
    if (!Number.isFinite(affordable)) return RUNAWAY_COST_CAP_USD;
    // Rounded down to the cent, so the ceiling never promises a fraction of
    // a credit the workspace does not have.
    const cents = Math.floor(affordable * 100) / 100;
    return Math.min(RUNAWAY_COST_CAP_USD, Math.max(MIN_CEILING_USD, cents));
  } catch (err) {
    console.warn(
      "could not read the credits a browser run may spend; using the runaway ceiling",
      err,
    );
    return RUNAWAY_COST_CAP_USD;
  }
}
