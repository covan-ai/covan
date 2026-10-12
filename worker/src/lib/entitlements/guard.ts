import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { getActiveWorkspaceId } from "../workspace";
import type { Spend, SpendRef } from "./index";

/**
 * Pre-flight check for a route that is about to spend.
 *
 *   const denied = await guardCredits(c, session.workspace_id);
 *   if (denied) return denied;
 *
 * **Charge the workspace the work belongs to**, which is not necessarily the
 * caller's active one: a member reading an old conversation from another
 * workspace spends that workspace's credits. A route that has loaded its row
 * passes the row's `workspace_id`; the three that have no row (a routine
 * draft, a transcription, a persona) pass nothing and the caller's active
 * workspace pays. Either way the id is left on the context for `recordCredits`.
 *
 * 402 Payment Required is the honest status for a refusal: the request is
 * well-formed and the caller is authorised — what is missing is credit.
 *
 * A failure to *read* the balance lets the request through. The ledger lives in
 * the same database as everything else, so a read failure means the app is
 * already in trouble; refusing every reply on top of that turns a billing
 * inconvenience into an outage. The error is logged so it cannot pass unnoticed.
 */
export async function guardCredits(
  c: Context<AppEnv>,
  workspaceId?: string | null,
): Promise<Response | null> {
  let id = workspaceId ?? null;
  if (!id) {
    try {
      id = await getActiveWorkspaceId(c.get("db"), c.get("user").id);
    } catch (err) {
      console.error("could not resolve the workspace to charge (allowing the request)", err);
      return null;
    }
  }
  // Nobody without a workspace can reach a route that spends — every account
  // gets one at sign-up — so this is a broken account, not a free one, and it
  // is let through for the read-failure reason above.
  if (!id) return null;
  c.set("workspaceId", id);

  let verdict;
  try {
    verdict = await c.get("entitlements").check(id);
  } catch (err) {
    console.error("credit check failed (allowing the request)", err);
    return null;
  }

  if (verdict.allowed) return null;
  return c.json({ error: "credits_exhausted", balance: verdict.balance }, 402);
}

/**
 * Post-flight accounting. Never throws: the work is already done and the reply
 * is already on its way, so a ledger that cannot be written must not turn a
 * successful operation into a failed one. Every path that calls this also
 * persists its token counts in its own table (`messages`, `routine_runs`), so a
 * dropped charge is recoverable from history rather than lost.
 *
 * Charges the workspace `guardCredits` resolved. A route that never called the
 * guard has nobody to charge, and says so in the log rather than guessing.
 */
export async function recordCredits(
  c: Context<AppEnv>,
  spent: Spend | Spend[] | null | undefined,
  ref: SpendRef = {},
): Promise<void> {
  const list = (Array.isArray(spent) ? spent : spent ? [spent] : []).filter(Boolean);
  if (list.length === 0) return;

  const workspaceId = c.get("workspaceId");
  if (!workspaceId) {
    console.error("recordCredits called without guardCredits — nothing charged", list);
    return;
  }

  try {
    await c.get("entitlements").record(workspaceId, list, { userId: c.get("user").id, ...ref });
  } catch (err) {
    console.error("failed to record credits", err);
  }
}
