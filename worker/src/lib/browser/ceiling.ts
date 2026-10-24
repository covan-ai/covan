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
 *   floor still covers, and it is HELD for the run (`reserve`) before the
 *   run starts, so a second run started meanwhile is bounded by what the
 *   first left rather than by the same untouched balance. The hosted build
 *   does the converting, so the rate never crosses into this tree.
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
 * The ceiling for a paid run in `workspaceId`, held under `holdId`.
 *
 * `holdId` is the run's `browser_tasks.id`, so the settle that charges the run
 * lets the hold go (`settle.ts`); a caller whose run does not start lets go
 * itself. Never refuses: whether the run may start at all is `check`'s
 * question, asked before this, and a run that finds every credit already held
 * by the runs beside it gets the smallest ceiling rather than a refusal. A
 * hold or a balance that cannot be read, or a deployment that converts no
 * dollars, gets the runaway ceiling alone — the answer an unmetered install
 * gets, and the one that loses nobody an answer.
 */
export async function paidRunCeiling(
  entitlements: Pick<Entitlements, "snapshot" | "quote" | "reserve">,
  workspaceId: string,
  holdId: string,
): Promise<number> {
  try {
    if (entitlements.reserve) {
      const held = await entitlements.reserve(workspaceId, holdId, RUNAWAY_COST_CAP_USD);
      return Number.isFinite(held) ? clamp(held) : RUNAWAY_COST_CAP_USD;
    }
    // An implementation that meters but cannot hold: the balance as it reads
    // now, and the overshoot `check` accepts when two runs start together.
    const credits = await entitlements.snapshot(workspaceId);
    const quote = quoteOf(entitlements);
    if (!credits.metered || credits.unlimited || !quote) return RUNAWAY_COST_CAP_USD;
    const perUsd = quote(1);
    if (!Number.isFinite(perUsd) || perUsd <= 0) return RUNAWAY_COST_CAP_USD;
    const affordable = (credits.balance - (credits.floor ?? 0)) / perUsd;
    return Number.isFinite(affordable) ? clamp(affordable) : RUNAWAY_COST_CAP_USD;
  } catch (err) {
    console.warn(
      "could not read the credits a browser run may spend; using the runaway ceiling",
      err,
    );
    return RUNAWAY_COST_CAP_USD;
  }
}

/**
 * Rounded down to the cent, so the ceiling never promises a fraction of a
 * credit the workspace does not have, and kept between a cent and a runaway.
 */
function clamp(usd: number): number {
  const cents = Math.floor(usd * 100) / 100;
  return Math.min(RUNAWAY_COST_CAP_USD, Math.max(MIN_CEILING_USD, cents));
}
