import type { Context } from "hono";
import type { AppEnv } from "../../types";

/**
 * Pre-flight check for a route that is about to spend tokens.
 *
 * Returns a 402 response to return as-is when the caller is over quota, or
 * `null` to carry on:
 *
 *   const denied = await guardQuota(c);
 *   if (denied) return denied;
 *
 * 402 Payment Required is the honest status here: the request is well-formed
 * and the caller is authorised — what is missing is budget.
 *
 * A failure to *read* the quota lets the request through. The counter lives in
 * the same database as everything else, so a read failure means the app is
 * already in trouble; refusing every reply on top of that turns a billing
 * inconvenience into an outage. The error is logged so it cannot pass unnoticed.
 */
export async function guardQuota(c: Context<AppEnv>): Promise<Response | null> {
  try {
    const verdict = await c.get("entitlements").check(c.get("user").id);
    if (verdict.allowed) return null;
    return c.json(
      {
        error: "quota_exceeded",
        used: verdict.used,
        limit: verdict.limit,
        resetsAt: verdict.resetsAt,
      },
      402,
    );
  } catch (err) {
    console.error("quota check failed (allowing the request)", err);
    return null;
  }
}

/**
 * Post-flight accounting. Never throws: the work is already done and the reply
 * is already on its way, so a counter that cannot be written must not turn a
 * successful operation into a failed one. Every path that calls this also
 * persists its token count in its own table (`messages`, `routine_runs`), so a
 * dropped increment is recoverable from history rather than lost.
 */
export async function recordQuota(c: Context<AppEnv>, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  try {
    await c.get("entitlements").record(c.get("user").id, Math.round(tokens));
  } catch (err) {
    console.error("failed to record token usage", err);
  }
}
