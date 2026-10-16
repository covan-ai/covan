import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { callerWorkspaceId } from "../workspace";
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
 *
 * Not knowing *whom* to charge is different, and is refused. It only arises for
 * the three routes with no row, and an answer there of "nobody" used to mean
 * the work was done and charged to no one — with no ceiling but the rate
 * limit. Replies are never in that position: they always pass their row's
 * workspace.
 */
export async function guardCredits(
  c: Context<AppEnv>,
  workspaceId?: string | null,
): Promise<Response | null> {
  let id = workspaceId ?? null;
  if (!id) {
    try {
      id = await callerWorkspaceId(c);
    } catch (err) {
      console.error("could not resolve the workspace to charge (allowing the request)", err);
      return null;
    }
  }
  // Every account gets a workspace at sign-up, so this is an account that has
  // since left all of them, or a lookup that could not finish. Either way
  // there is nobody to charge, and work nobody pays for is not offered.
  if (!id) return c.json({ error: "no workspace to charge for this" }, 403);
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
