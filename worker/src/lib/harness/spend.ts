import { entitlementsFor } from "../entitlements";
import { isRuntimeLimit } from "../runtime-limit";
import type { ToolContext, ToolResult } from "./registry";

/**
 * A tool that costs the operator money outside the model bill.
 *
 * Every other spend in this codebase is a completion or a transcription, and
 * every one of them is metered by the ROUTE that bought it — `guardQuota`
 * before, `recordQuota` after. A Composio call cannot be: the decision to make
 * it is the model's, several times per turn, and the route has no way to know
 * how many there will be or whether there will be any.
 *
 * **This is the codebase's only unconditional spend, and that is deliberate.**
 * `recordQuota` gates on `billsTheOperator(keys)` and `guardQuota` lets an
 * exhausted caller straight through when their workspace carries its own OpenAI
 * key (`lib/entitlements/guard.ts`, case 2). Both are right about OpenAI and
 * both are wrong here: a workspace key pays for completions, and nothing
 * anybody can bring pays for Composio — the API key is the operator's, on every
 * deployment, with no per-workspace door beside it. So the question
 * `billsTheOperator` answers does not arise, and asking it anyway would mean an
 * account that had hit its limit could spend the operator's Composio budget
 * without bound by pasting an OpenAI key. If somebody "fixes" this to match the
 * others, that is the bug they will have introduced.
 */

/**
 * Whether this caller may spend, asked BEFORE the network.
 *
 * Returns the refusal to hand back to the model, or null to go ahead. A
 * sentence rather than a status, because the reader is a model deciding what to
 * do next and "you are out of allowance" is something it can say to a person.
 *
 * A failed check lets the call through, which is `guardQuota`'s own rule and is
 * here for the same reason: the counter lives in the database everything else
 * lives in, so a read failure means the app is already in trouble, and refusing
 * every action on top of that turns a billing inconvenience into an outage.
 *
 * It takes no cost, because `Entitlements.check` takes none: the interface says
 * outright that answering `allowed` is a statement about the past rather than a
 * reservation, so a caller can overshoot its limit by one operation. That is
 * the same latitude a chat turn already has.
 */
export async function affordable(ctx: ToolContext): Promise<ToolResult | null> {
  try {
    const verdict = await entitlementsFor(ctx.env).check(ctx.userId);
    if (verdict.allowed) return null;
    return {
      kind: "error",
      message:
        "this account has used its allowance for the period, and calling a connected " +
        `service is not something a workspace's own provider key can cover. It resets on ` +
        `${verdict.resetsAt}. Say so plainly rather than retrying.`,
    };
  } catch (err) {
    // The one failure that must NOT be forgiven, and the reason is not
    // billing. If the check failed because this invocation is out of
    // subrequests, the call it was guarding cannot go out either — a
    // connected-app call is a `fetch` like any other — so allowing it buys a
    // certain failure one step later, with a worse message. Refusing here
    // spends the last of the turn saying something true.
    //
    // Everything else keeps the forgiving path, which is `guardQuota`'s own
    // rule: the counter lives in the database everything else lives in, so a
    // read failure means the app is already in trouble, and refusing every
    // action on top of that turns a billing inconvenience into an outage.
    if (isRuntimeLimit(err)) {
      if (ctx.runtimeLimit) ctx.runtimeLimit.hit = true;
      console.error("connected-service call refused: invocation out of subrequests", err);
      return {
        kind: "error",
        message:
          "this turn has used up the requests it is allowed to make, so nothing further " +
          "can be looked up or called. Answer with what you already have and say plainly " +
          "that you could not finish.",
      };
    }
    console.error("composio quota check failed (allowing the call)", err);
    return null;
  }
}

/**
 * Post-flight accounting. Never throws, for `recordQuota`'s reason: the money
 * is already spent and the answer is already on its way, so a counter that
 * cannot be written must not turn a successful call into a failed one.
 */
export async function spend(ctx: ToolContext, tokens: number): Promise<void> {
  try {
    await entitlementsFor(ctx.env).record(ctx.userId, tokens);
  } catch (err) {
    // Still never throws. It does raise the flag, because a write that could
    // not be made for this reason is the same fact as a read that could not
    // be made, and the route explaining the turn should hear about it from
    // whichever of them happened to be the one that noticed.
    if (isRuntimeLimit(err) && ctx.runtimeLimit) ctx.runtimeLimit.hit = true;
    console.error("failed to record a connected-service call", err);
  }
}

/**
 * Whether a failed call cost anything.
 *
 * Composio bills for the attempt, not for the outcome, so a 400 is charged and
 * has to be counted — a counter that only counted successes could be run up by
 * failing. The exceptions are the two failures that never reached them: no key
 * configured (501, raised by `lib/composio/client.ts` before any request) and
 * the request not getting out of the building (502). Charging for those would
 * be charging somebody for our own misconfiguration.
 */
export function wasBilled(status: number): boolean {
  return status !== 501 && status !== 502;
}
