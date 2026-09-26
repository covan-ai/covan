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
 *      through a `tool_connection_grants` row set to `always` (0063).
 *   4. **The allowance is checked before the network**, because this is the one
 *      thing in Covan that spends the operator's money outside the model bill
 *      and cannot be covered by a workspace's own key. See `lib/harness/spend.ts`.
 *
 * WHY THE DESCRIPTION TALKS ABOUT TRIMMING. The first real use of this tool —
 * "list my last five meetings" — spent five calls on one question, and four of
 * them were the model narrowing: a wide window, then a smaller one, then fewer
 * fields, each call discovering `MAX_TOOL_OUTPUT_CHARS` by hitting it. `cap()`
 * does say a result was trimmed, but it says so afterwards, and by then the
 * call is paid for twice — once at Composio, and again on every remaining pass
 * of the turn, which is where the money actually goes. Saying it in the
 * description instead costs about sixty tokens a turn and saves four steps, so
 * it is written there rather than learned here. Keep the fact if you rewrite
 * the wording.
 */

/** Enough of Composio's own failure to act on, not enough to fill a turn. */
const MAX_ERROR_CHARS = 2_000;

/** How many complaints one refusal carries. Enough to fix in one go, not a wall. */
const MAX_COMPLAINTS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What JSON Schema calls a type, as a question about a value. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      // A type this does not know is not a type it may refuse on. Composio's
      // schemas also describe fields with `anyOf` and no `type` at all.
      return true;
  }
}

/** What was sent, named the way an error message can use. */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isRecord(value)) return "an object";
  return `a ${typeof value}`;
}

/**
 * Where the arguments disagree with the schema, in the model's own terms.
 *
 * Deliberately narrow, because a validator that is wrong blocks calls that would
 * have worked. It refuses only on what is unambiguous — a required field absent,
 * a declared scalar type contradicted, an array whose declared item type is
 * contradicted — and stays silent on everything else: a property the schema does
 * not mention, a field described by `anyOf` rather than `type`, a type name it
 * does not recognise.
 *
 * The three shapes it catches are the three that were actually sent in
 * production on 2026-09-26: `attendees` as objects where Composio wants strings,
 * `send_updates` as the string the docs promise where Composio wants a boolean,
 * and `start_datetime` missing because the datetime went in a nested `start`
 * instead. See #192 and #195.
 */
function complaints(args: Record<string, unknown>, schema: Record<string, unknown>): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const out: string[] = [];

  for (const name of required) {
    if (typeof name === "string" && args[name] === undefined) {
      out.push(`\`${name}\` is required and was not sent`);
    }
  }

  if (properties) {
    for (const [name, value] of Object.entries(args)) {
      const spec = properties[name];
      if (!isRecord(spec)) continue;
      const type = typeof spec.type === "string" ? spec.type : null;
      if (!type) continue;
      if (!matchesType(value, type)) {
        out.push(
          `\`${name}\` should be ${type === "array" ? "an array" : `a ${type}`}, not ${shapeOf(value)}`,
        );
        continue;
      }
      if (type !== "array" || !Array.isArray(value) || !isRecord(spec.items)) continue;
      const itemType = typeof spec.items.type === "string" ? spec.items.type : null;
      if (!itemType) continue;
      value.forEach((item, i) => {
        if (!matchesType(item, itemType)) {
          out.push(`\`${name}[${i}]\` should be a ${itemType}, not ${shapeOf(item)}`);
        }
      });
    }
  }

  return out.slice(0, MAX_COMPLAINTS);
}

/** Whether a standing grant says this operation never needs asking. */
async function alwaysAllowed(
  ctx: ToolContext,
  connection: ToolConnection,
  slug: string,
): Promise<boolean> {
  // Through the caller's own client on the chat path and the engine's on the
  // scheduled one; both are covered — 0063 grants `select` to `authenticated`
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
    "is asked to approve the first action on each service. Ask narrowly on the first " +
    "call: the answer is trimmed, so a wide request comes back cut off and costs you " +
    "another call. Use the smallest time range and result count the operation accepts, " +
    "and name only the fields you need.",
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
        description:
          "The operation's arguments, as its schema describes them. Set whatever limits it " +
          "offers — time range, maximum results, list of fields — as small as the question " +
          "allows.",
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

    // Guard 0, and it is first because it is the only one that costs nothing.
    // The description tells the model this rule; this is what makes it true.
    //
    // Only when `find_tool` has answered this turn. An empty set means the slug
    // came from somewhere this tool cannot see — an earlier turn still in the
    // transcript, a standing grant, a person's own instruction — and refusing
    // those would break working behaviour to prevent a mistake that has not
    // happened. A confirmed call skips it too: the slug went through here when
    // it was proposed, and refusing it after somebody said yes would be a
    // second opinion nobody asked for.
    const offered = ctx.offeredSlugs;
    if (ctx.confirmed !== true && offered && offered.size > 0 && !offered.has(slug)) {
      return {
        kind: "error",
        message:
          `${slug} is not an operation find_tool returned. You have been given: ` +
          `${[...offered].join(", ")}. Run one of those, or search again if what you ` +
          "want is not among them — do not vary a slug by hand, the catalogue does not " +
          "follow a naming pattern you can guess.",
      };
    }

    // Guard 1, and it is here rather than beside the network because it costs
    // nothing and because a person should not be asked to approve a call that
    // is going to be refused anyway.
    //
    // Only for an operation `find_tool` described this turn — see
    // `offeredSchemas`. A confirmed call is checked too: the arguments are the
    // ones that were proposed, so if they are wrong, spending the call to be
    // told so is the one outcome nobody wanted.
    const schema = ctx.offeredSchemas?.get(slug);
    if (schema) {
      const wrong = complaints(callArgs, schema);
      if (wrong.length > 0) {
        return {
          kind: "error",
          message:
            `${slug} was not sent what its schema asks for, so it was not run:\n` +
            `${wrong.map((w) => `- ${w}`).join("\n")}\n` +
            "Fix the arguments and call again. This operation's schema is the one that " +
            "decides, not the service's own API documentation — they differ.",
        };
      }
    }

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
    // 0063 grants neither column to any client role, for the reason that
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
      /**
       * An operation the catalogue advertised and the service does not have.
       *
       * `find_tool` returned `GOOGLECALENDAR_BATCH_EVENTS` with a full argument
       * schema on 2026-09-26 and Composio's execute endpoint answered
       * `404 Tool_ToolNotFound`. The guard above had passed it correctly — it
       * was offered — and nothing in the turn learned otherwise, so a retry
       * would have bought a second 404.
       *
       * So the slug is withdrawn, and the answer names what is left. Keyed on
       * Composio's own error slug rather than on the status alone, because a 404
       * can also mean the connected account is gone, and that one is worth
       * retrying. If they reword it, this degrades to the plain forwarded error
       * below, which is today's behaviour.
       */
      if (result.status === 404 && result.message.includes("Tool_ToolNotFound")) {
        ctx.offeredSlugs?.delete(slug);
        ctx.offeredSchemas?.delete(slug);
        const left = [...(ctx.offeredSlugs ?? [])];
        return {
          kind: "error",
          message:
            `${slug} is in the catalogue but ${connection.label} does not have it, so it ` +
            "cannot be run here and will not be offered again this turn. " +
            (left.length > 0
              ? `Use one of these instead: ${left.join(", ")}.`
              : "Search for a different operation, or tell the person this is not something " +
                "you can do."),
        };
      }
      // The far end's own sentence, forwarded rather than flattened, for the
      // reason `http_request` forwards a 400 body: "unknown field `recipient`"
      // is what lets the model fix its next call.
      return { kind: "error", message: result.message.slice(0, MAX_ERROR_CHARS) };
    }
    return { kind: "ok", content: result.body || "(the operation returned nothing)" };
  },
};
