import { entitlementsFor, type Spend, type SpendRef } from "../entitlements";
import { isRuntimeLimit } from "../runtime-limit";
import type { ToolContext, ToolResult } from "./registry";

/**
 * A tool that costs the operator money outside the model bill.
 *
 * Every other spend in this codebase is a completion, an embedding or a
 * transcription, and every one of them is charged by the ROUTE that bought it —
 * `guardCredits` before, `recordCredits` after. A Composio call or a browser
 * task cannot be: the decision to make it is the model's, several times per
 * turn, and the route has no way to know how many there will be.
 *
 * So the tool asks for itself, against the workspace the turn belongs to
 * (`ctx.workspaceId`) — the same workspace the route charged.
 */

/**
 * Whether this caller may spend, asked BEFORE the network.
 *
 * Returns the refusal to hand back to the model, or null to go ahead. A
 * sentence rather than a status, because the reader is a model deciding what to
 * do next and "you are out of credits" is something it can say to a person.
 *
 * A failed check lets the call through, which is `guardCredits`'s own rule and is
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
    const verdict = await entitlementsFor(ctx.env).check(ctx.workspaceId);
    if (verdict.allowed) return null;
    return {
      kind: "error",
      message:
        "this workspace has no credits left, so connected services cannot be called until " +
        "a workspace admin adds more. Say so plainly rather than retrying.",
    };
  } catch (err) {
    // The one failure that must NOT be forgiven, and the reason is not
    // billing. If the check failed because this invocation is out of
    // subrequests, the call it was guarding cannot go out either — a
    // connected-app call is a `fetch` like any other — so allowing it buys a
    // certain failure one step later, with a worse message. Refusing here
    // spends the last of the turn saying something true.
    //
    // Everything else keeps the forgiving path, which is `guardCredits`'s own
    // rule: the ledger lives in the database everything else lives in, so a
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
 * Post-flight accounting. Never throws, for `recordCredits`'s reason: the money
 * is already spent and the answer is already on its way, so a counter that
 * cannot be written must not turn a successful call into a failed one.
 */
export async function spend(ctx: ToolContext, spent: Spend[], ref: SpendRef = {}): Promise<void> {
  if (spent.length === 0) return;
  try {
    await entitlementsFor(ctx.env).record(ctx.workspaceId, spent, {
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? undefined,
      ...ref,
    });
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
 * has to be counted — a ledger that only counted successes could be run up by
 * failing. The exceptions are the two failures that never reached them: no key
 * configured (501, raised by `lib/composio/client.ts` before any request) and
 * the request not getting out of the building (502). Charging for those would
 * be charging somebody for our own misconfiguration.
 */
export function wasBilled(status: number): boolean {
  return status !== 501 && status !== 502;
}
