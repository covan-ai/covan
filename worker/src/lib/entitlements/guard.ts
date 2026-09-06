import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { deferred } from "../defer";
import { billsTheOperator, houseKeys, keysForUser, withProviderKeys } from "../keys/resolve";
import { warnIfLow } from "./warn";

/**
 * Pre-flight check for a route that is about to spend tokens.
 *
 * Three outcomes, in order:
 *
 *   1. Within allowance — `null`, and the operator's keys answer.
 *   2. Out of allowance, but the caller's workspace has its own key — `null`,
 *      and that key answers. `c.get("providerEnv")` carries it, and
 *      `c.get("providerKeys")` carries whose it is.
 *   3. Out of allowance with no workspace key — a 402 to return as-is.
 *
 *   const denied = await guardQuota(c);
 *   if (denied) return denied;
 *
 * 402 Payment Required is the honest status for the third case: the request is
 * well-formed and the caller is authorised — what is missing is budget.
 *
 * A failure to *read* the quota lets the request through on the operator's key.
 * The counter lives in the same database as everything else, so a read failure
 * means the app is already in trouble; refusing every reply on top of that turns
 * a billing inconvenience into an outage. The error is logged so it cannot pass
 * unnoticed. `keysForUser` fails the same way, for the same reason.
 */
export async function guardQuota(c: Context<AppEnv>): Promise<Response | null> {
  const userId = c.get("user").id;

  let verdict;
  try {
    verdict = await c.get("entitlements").check(userId);
  } catch (err) {
    console.error("quota check failed (allowing the request)", err);
    return null;
  }

  if (verdict.allowed) return null;

  // Out of allowance. Before refusing, ask whether the workspace is carrying it
  // from here. Only reached on the exhausted path, so the common case pays for
  // no extra lookup.
  const keys = await keysForUser(c.env, c.get("db"), userId, false);
  if (!billsTheOperator(keys)) {
    c.set("providerKeys", keys);
    c.set("providerEnv", withProviderKeys(c.env, keys));
    return null;
  }

  return c.json(
    {
      error: "quota_exceeded",
      used: verdict.used,
      limit: verdict.limit,
      resetsAt: verdict.resetsAt,
    },
    402,
  );
}

/**
 * Post-flight accounting. Never throws: the work is already done and the reply
 * is already on its way, so a counter that cannot be written must not turn a
 * successful operation into a failed one. Every path that calls this also
 * persists its token count in its own table (`messages`, `routine_runs`), so a
 * dropped increment is recoverable from history rather than lost.
 *
 * Only what the operator is billed for is counted here, and that is asked as a
 * question with exactly that shape — `billsTheOperator` — rather than as
 * "unless the workspace paid". The counter means
 * "what the operator is billed for", and a number that climbs without bound past
 * a limit it can no longer enforce is not that. Leaving `used` pinned just above
 * `limit` is also what keeps the state stable: `check` keeps saying denied, the
 * workspace key keeps answering, and nothing oscillates. What the team spent on
 * their own key is still visible — the per-agent figures on the usage screen are
 * built from `messages`, not from this counter.
 */
export async function recordQuota(c: Context<AppEnv>, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;

  // Asked positively, and through the same predicate the three context-free
  // paths use, so that all five sites in the codebase phrase the money question
  // identically. `providerKeys` is set by `guardQuota` only where it actually
  // resolved a key — the out-of-allowance branch — so its absence means branch
  // one, where the operator's own keys answered by definition and there was
  // nothing to look up. `houseKeys(c.env)` is what that absence *means*, spelled
  // out rather than left as an `undefined` this predicate would have to special
  // case.
  if (!billsTheOperator(c.get("providerKeys") ?? houseKeys(c.env))) return;

  try {
    await c.get("entitlements").record(c.get("user").id, Math.round(tokens));
  } catch (err) {
    console.error("failed to record token usage", err);
  }

  // Here rather than in each of the routes that spend: this function is already
  // the one thing they all call afterwards, and a new paid endpoint added a year
  // from now gets the warning without anybody remembering to wire it.
  // `warnIfLow` returns before it reads anything when there is no allowance,
  // which is every self-hosted deployment.
  //
  // Deferred rather than awaited. On a metered deployment this is a snapshot and
  // a preferences read, and awaiting it would put two queries between the last
  // token of a reply and the person seeing it — on every reply, to send at most
  // one message a month.
  deferred(c, warnIfLow(c));
}
