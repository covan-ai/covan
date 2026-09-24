import { composioConfigured, executeTool } from "../../composio/client";
import { COMPOSIO_CALL_TOKENS } from "../../entitlements";
import { loadConnection, type ToolConnection } from "../connections";
import { composioAccount } from "../secrets";
import { affordable, spend, wasBilled } from "../spend";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * Run one operation at a connected application.
 *
 * WHY THIS IS NOT `http_request` WITH A COMPOSIO BASE URL, despite the obvious
 * reuse and the fact that everything below the guards is the same HTTP call.
 * Composio's execute body carries the connected account to act as. In
 * `http_request` the body is written by the MODEL — that is what makes it
 * general — and `registry.ts` states the rule that forbids it: "every id here
 * is resolved, never passed in by the model". A model-written account
 * reference on a deployment where one API key opens every workspace's accounts
 * is one hallucinated identifier away from another workspace's mailbox. So
 * Covan resolves both identifiers from the row, server side, and the model
 * chooses the slug and the arguments and nothing else.
 *
 * FOUR THINGS HOLD THIS, in the order they are checked, and none of them is the
 * model behaving well:
 *
 *   1. **The connection is the caller's.** `loadConnection` reads through their
 *      own client and filters by workspace on top, so an id from another tenant
 *      is not found rather than refused.
 *   2. **The operation belongs to the connection.** A Slack connection paired
 *      with `GMAIL_SEND_EMAIL` is refused here, locally, before anything leaves
 *      the building — not by Composio's 400, which would have been a request
 *      made on somebody's behalf.
 *   3. **A person said yes.** Once per connection per turn, or in advance
 *      through a `tool_connection_grants` row set to `always` (0062).
 *   4. **The allowance is checked before the network**, because this is the one
 *      thing in Covan that spends the operator's money outside the model bill
 *      and cannot be covered by a workspace's own key. See `lib/harness/spend.ts`.
 */

/** Enough of Composio's own failure to act on, not enough to fill a turn. */
const MAX_ERROR_CHARS = 2_000;

/** Whether a standing grant says this operation never needs asking. */
async function alwaysAllowed(
  ctx: ToolContext,
  connection: ToolConnection,
  slug: string,
): Promise<boolean> {
  // Through the caller's own client on the chat path and the engine's on the
  // scheduled one; both are covered — 0062 grants `select` to `authenticated`
  // and to `service_role`, and the composite foreign keys are what make a
  // cross-tenant grant impossible rather than merely disallowed, which matters
  // precisely because the scheduled read has no caller for RLS to resolve.
  const { data, error } = await ctx.db
    .from("tool_connection_grants")
    .select("mode")
    .eq("agent_id", ctx.agentId)
    .eq("tool_connection_id", connection.id)
    .eq("slug", slug)
    .maybeSingle();
  // A grant that cannot be read is not a grant. Failing closed here costs a
  // question; failing open would let a database hiccup remove the asking.
  if (error) return false;
  return data?.mode === "always";
}

export const runToolTool: AgentTool = {
  name: "run_tool",
  description:
    "Run one operation at an application this workspace has connected — send the mail, " +
    "create the issue, update the record. You give the connection id, the operation slug " +
    "you found with find_tool, and the arguments that operation takes. Find the slug " +
    "first; a slug you have not seen in a find_tool result will be refused. The person " +
    "is asked to approve the first action on each service.",
  input: {
    type: "object",
    properties: {
      connectionId: {
        type: "string",
        description: "The id of a connected application, from the list of connected services.",
      },
      slug: {
        type: "string",
        description: "The operation, exactly as find_tool gave it. GMAIL_SEND_EMAIL.",
      },
      arguments: {
        type: "object",
        description: "The operation's arguments, as its schema describes them.",
        additionalProperties: true,
      },
    },
    required: ["connectionId", "slug"],
    additionalProperties: false,
  },
  // The Integrations page prints this, so "what can this agent actually do" is
  // answerable without reading the code. A tool that can send mail as somebody
  // is the most destructive thing in the list.
  destructive: true,
  needs: "connection",
  isConfigured: (env: ToolEnv) => composioConfigured(env),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { connectionId?: unknown; slug?: unknown; arguments?: unknown };
    if (typeof input.connectionId !== "string" || !input.connectionId) {
      return { kind: "error", message: "connectionId is required" };
    }
    if (typeof input.slug !== "string" || !input.slug.trim()) {
      return { kind: "error", message: "slug is required — find one with find_tool first" };
    }
    const slug = input.slug.trim();
    // Anything but a flat object is refused rather than coerced. An array or a
    // string here means the model has misread the schema, and sending it on
    // would spend a call to be told so by Composio.
    const callArgs =
      input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
        ? (input.arguments as Record<string, unknown>)
        : {};

    const connection = await loadConnection(ctx, input.connectionId);
    if (!connection) return { kind: "error", message: "no such connection in this workspace" };
    if (connection.transport !== "composio") {
      // The redirect `query_database` already gives, in the other direction.
      return {
        kind: "error",
        message:
          `${connection.label} is not a connected application — use ` +
          `${connection.transport === "http" ? "http_request" : "query_database"} for it`,
      };
    }
    if (connection.status !== "active") {
      return {
        kind: "error",
        message:
          `${connection.label} has not finished connecting. Somebody needs to complete it ` +
          "on the Integrations page before you can use it.",
      };
    }

    // Guard 2. Locally, before anything leaves the building: pairing a Slack
    // connection with a Gmail slug is a mistake, and finding out from
    // Composio's 400 would mean the request had already been made.
    const toolkit = slug.split("_")[0]?.toLowerCase() ?? "";
    if (!connection.toolkit_slug || connection.toolkit_slug !== toolkit) {
      return {
        kind: "error",
        message:
          `${slug} is not an operation of ${connection.toolkit_slug ?? "this connection"}. ` +
          `${connection.label} connects ${connection.toolkit_slug ?? "an application"} — use ` +
          "find_tool with that toolkit to find the right operation, or name a different " +
          "connection.",
      };
    }

    // Guard 3. Three ways to be allowed, in the order that costs least.
    const approved =
      ctx.confirmed === true ||
      (ctx.approvedConnections ?? []).includes(connection.id) ||
      (await alwaysAllowed(ctx, connection, slug));

    if (!approved) {
      // Nobody is watching a scheduled run, so an unanswerable question is
      // worse than an honest failure: `needs_confirmation` would return
      // `paused` from `runAgentTurn` and abandon the rest of the run
      // (`loop.ts`). The reason goes in the error string rather than the pause,
      // because `agent-run.ts` only appends its "stopped short of…" note on
      // `paused.reason === "confirmation"` — so said here it reaches the
      // report, and said there it would end the run.
      if (ctx.routineRunId) {
        return {
          kind: "error",
          message:
            `${slug} on ${connection.label} needs a person to approve it and nobody is ` +
            "watching a scheduled run. Report that you could not do it. Somebody can set " +
            "this operation to always-allow on the Integrations page if it should happen " +
            "unattended.",
        };
      }
      return {
        kind: "needs_confirmation",
        summary: `Run ${slug} on ${connection.label}?`,
        proposal: {
          kind: "run_tool",
          connection: { id: connection.id, label: connection.label },
          toolkit: connection.toolkit_slug,
          slug,
          arguments: callArgs,
        },
      };
    }

    // Guard 4, and it is the last thing before the network on purpose.
    const refused = await affordable(ctx);
    if (refused) return refused;

    // The two identifiers the model never sees, read with the service role
    // after the caller's own client has already said they may have this row.
    // 0062 grants neither column to any client role, for the reason that
    // migration's banner gives at length.
    const account = await composioAccount(ctx.env, connection);
    if (!account) {
      return {
        kind: "error",
        message:
          `${connection.label} is missing the account it was connected with. It needs to be ` +
          "reconnected on the Integrations page.",
      };
    }

    const result = await executeTool(
      ctx.env,
      {
        slug,
        connectedAccountId: account.connectedAccountId,
        userId: account.composioUserId,
        arguments: callArgs,
      },
      { signal: ctx.signal },
    );
    // Recorded whether it worked or not. Composio bills for the attempt, and a
    // counter that only counts successes is a counter that can be run up by
    // failing — `wasBilled` is what keeps the two failures that never reached
    // them out of it.
    if (result.kind === "ok" || wasBilled(result.status)) {
      await spend(ctx, COMPOSIO_CALL_TOKENS);
    }

    if (result.kind === "error") {
      // The far end's own sentence, forwarded rather than flattened, for the
      // reason `http_request` forwards a 400 body: "unknown field `recipient`"
      // is what lets the model fix its next call.
      return { kind: "error", message: result.message.slice(0, MAX_ERROR_CHARS) };
    }
    return { kind: "ok", content: result.body || "(the operation returned nothing)" };
  },
};
