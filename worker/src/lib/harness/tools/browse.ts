import { createTask, hasBrowserKey } from "../../browser/client";
import { BROWSER_TASK_TOKENS, entitlementsFor } from "../../entitlements";
import { affordable, spend, wasBilled } from "../spend";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * A web page, opened by somebody else's browser.
 *
 * This is the one tool in the registry that does not answer the question it
 * was asked. It hands the work to browser-use, records where the answer has
 * to come back to, and returns a task id — and then the turn ENDS.
 *
 * **That is the design, and it is the part most likely to be undone by
 * somebody trying to be helpful.** A version of this tool that waited would
 * burn the step budget polling (`MAX_STEPS` is 8 on Workers Free), and every
 * poll's result would re-enter the transcript and be re-sent on every later
 * pass — so cost would grow with the SQUARE of the poll count, which is the
 * one cost shape `lib/harness/budget.ts` exists to refuse. A browser task
 * takes minutes. Minutes do not fit in a chat turn. Polling belongs outside
 * the model loop, and it lives in `lib/browser/poller.ts`.
 *
 * **One argument, deliberately.** Not a URL plus a goal, not a step list. The
 * provider's own agent decomposes a sentence; a second argument would be
 * Covan second-guessing a loop it did not write. It is also what makes the
 * approval card honest: with no endpoint, no method and no origin to inspect,
 * the sentence IS the blast radius, so one sentence is the whole of what a
 * person is shown and the whole of what they agree to.
 *
 * **No `needs`, and that is the direct lesson of the Composio attempt.** A
 * browser task points at the public web, not at a tenant's connected
 * service — so there is no `tool_connections` row, no catalogue lookup and no
 * connection id. The connection-and-catalogue machinery was the entire source
 * of that breakage; none of it is needed here.
 */

/** Shorter than this is not a task, it is a word. Matches the schema's `minLength`. */
const MIN_TASK_CHARS = 10;

export { BROWSER_TASK_TOKENS };

/**
 * What the card says a task costs, or nothing at all.
 *
 * Returned as one human sentence rather than a number, because the proposal
 * card renders fields as rows and "cost: 137000" is a row that tells nobody
 * anything. A task is about 14% of a month, which is a big enough bite that
 * somebody should see it before saying yes.
 *
 * Null on an unmetered deployment — `limit: null` is the interface's way of
 * saying no quota exists — and null if the read fails. Never a guess: a made
 * up share on a self-hosted install would be a sentence about a ceiling that
 * is not there.
 */
async function allowanceNote(ctx: ToolContext): Promise<string | null> {
  try {
    const { used, limit } = await entitlementsFor(ctx.env).snapshot(ctx.userId);
    if (!limit) return null;
    const share = Math.round((BROWSER_TASK_TOKENS / limit) * 100);
    const left = Math.max(0, Math.floor((limit - used) / BROWSER_TASK_TOKENS));
    return (
      `about ${share}% of this month's allowance ` +
      `(${left} browser ${left === 1 ? "task" : "tasks"} left after this one)`
    );
  } catch (err) {
    // Advisory. A person who cannot be told the price should still be asked
    // the question — the alternative is a tool that stops working because a
    // counter is down.
    console.error("could not read the allowance for a browser task", err);
    return null;
  }
}

export const browseTool: AgentTool = {
  name: "browse",
  description:
    "Do something on a web page: read a page that needs JavaScript, pull a number out of a " +
    "site with no API, follow a few links and report back. You give ONE instruction in plain " +
    "language and a real browser carries it out elsewhere. This does not answer you now — it " +
    "starts the work and comes back with the answer as a new message in a few minutes, so say " +
    "that you have started it and do not wait or ask again. Public pages only: it cannot sign " +
    "in to anything. Use http_request instead when the thing you want has an API.",
  input: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: MIN_TASK_CHARS,
        description:
          "One instruction, in plain language, naming the site and what to get or do. " +
          "The person is shown this sentence word for word and has to approve it.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  destructive: true,
  // No `needs`: there is no connection and no channel for this to point at.
  isConfigured: (env: ToolEnv) => hasBrowserKey(env),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { task?: unknown };
    if (typeof input.task !== "string" || !input.task.trim()) {
      return { kind: "error", message: "task is required" };
    }
    const task = input.task.trim();
    if (task.length < MIN_TASK_CHARS) {
      return {
        kind: "error",
        message: "say what to do in one sentence — which site, and what to get or do there",
      };
    }

    /**
     * Nobody is watching a scheduled run, and the answer to a browser task
     * arrives minutes later as a message in a conversation. A routine has no
     * conversation to arrive in, which is the same thing `paused_turns` says
     * by making `session_id` not null (0060:124-128). So this is an honest
     * failure rather than a task whose answer has nowhere to go.
     */
    if (!ctx.sessionId) {
      return {
        kind: "error",
        message:
          "a browser task reports back into a conversation and a scheduled run has none, so " +
          "this cannot be done unattended. Say so plainly rather than retrying.",
      };
    }

    if (ctx.confirmed !== true) {
      const cost = await allowanceNote(ctx);
      return {
        kind: "needs_confirmation",
        summary: "Use a browser to do this?",
        proposal: {
          kind: "browse",
          // Verbatim, and untruncated. §4: this sentence is the entire
          // description of what is being authorised.
          task,
          ...(cost ? { cost } : {}),
        },
      };
    }

    // Before the network, because a browser task is real money at a third
    // party and an exhausted account must not be able to start one. See
    // `lib/harness/spend.ts`.
    const refused = await affordable(ctx);
    if (refused) return refused;

    const created = await createTask(ctx.env, { task }, { signal: ctx.signal });

    if (created.kind === "error") {
      // 429 is the concurrency pool, which is account-wide and shared across
      // every tenant on this deployment — ten sessions at $0 lifetime spend.
      // v1 refuses and says so; a queue is a later problem with real numbers
      // behind it.
      if (created.status === 429) {
        return {
          kind: "error",
          message:
            "every browser this deployment can run is busy. Say so and offer to try again in a " +
            "few minutes; do not retry this turn.",
        };
      }
      // Charged only when they took the request. `wasBilled` is the existing
      // rule for which failures are somebody's money.
      if (wasBilled(created.status) && created.status !== 0) {
        await spend(ctx, BROWSER_TASK_TOKENS);
      }
      return { kind: "error", message: `could not start the browser task: ${created.message}` };
    }

    /**
     * The row is written BEFORE the charge, and that order is the point: a
     * task at the provider that nothing in this database knows about is money
     * spent on work whose answer can never be delivered. If the insert fails
     * the honest thing is to say so and charge nothing — the browser will run
     * and nobody will read it, which is bad, but charging for it as well
     * would be worse.
     */
    const { data, error } = await ctx.db
      .from("browser_tasks")
      .insert({
        workspace_id: ctx.workspaceId,
        agent_id: ctx.agentId,
        user_id: ctx.userId,
        session_id: ctx.sessionId,
        provider_task_id: created.value.id,
        task,
        status: "queued",
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("started a browser task but could not record it", error);
      return {
        kind: "error",
        message:
          "the browser task started but could not be recorded, so its answer cannot be " +
          "delivered. Say that plainly and do not start another.",
      };
    }

    await spend(ctx, BROWSER_TASK_TOKENS);

    return {
      kind: "ok",
      content:
        "Started. A browser is doing this now and it usually takes a few minutes. The answer " +
        "will arrive as a new message in this conversation — tell the person that and finish " +
        "your reply. Do not call browse again for this.",
    };
  },
};
