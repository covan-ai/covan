import { composioConfigured, getTool, searchTools, type ComposioTool } from "../../composio/client";
import { COMPOSIO_SEARCH_TOKENS } from "../../entitlements";
import { listConnections, type ToolConnection } from "../connections";
import { affordable, spend, wasBilled } from "../spend";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * The catalogue, as something the agent searches rather than something it is
 * handed.
 *
 * Composio describes roughly fifteen hundred applications. Their own toolset
 * puts a service's operations into the model's tool array, which works at five
 * and does not work at fifteen hundred — the array is sent on every pass of
 * every turn, so the cost is paid per token per turn forever. Search is the
 * shape that scales: the model says what it is trying to do, gets five
 * candidates back, and the turn carries five lines instead of a catalogue.
 *
 * **Discovery is catalogue-wide; execution is not.** This tool searches every
 * application Composio knows, connected or not, and it touches no customer data
 * to do it — the question "is there an operation that archives a Linear issue"
 * has no tenant in it. Actually running one needs a row in `tool_connections`,
 * which needs somebody to have completed a consent screen. Keeping those two
 * separate is what lets an agent answer "you would need to connect Linear
 * first" instead of failing silently at a capability nobody knew was missing.
 *
 * WHY IT IS OFFERED TO A WORKSPACE WITH NOTHING CONNECTED. `needs` is
 * deliberately undefined — `available.ts` falls through to `true` for an absent
 * `needs` — because the whole value of a tool that can see the unconnected half
 * of the catalogue is that it can be asked before anything is connected.
 */

/**
 * How many candidates come back.
 *
 * Five, and the ceiling is not politeness. `loop.ts` caps every result at
 * `MAX_TOOL_OUTPUT_CHARS` with a blind slice, and the result is re-sent to the
 * model on every remaining pass of the turn — so a long answer is paid for
 * repeatedly and then truncated mid-sentence. Five one-line summaries fit with
 * room to spare.
 */
const MAX_RESULTS = 5;

/** A full argument schema is verbose. This is what one is allowed to cost. */
const MAX_SCHEMA_CHARS = 4_000;

/**
 * How much of a failed query to keep when asking the catalogue a second time.
 *
 * Composio's tool search is far more brittle than a sentence suggests, and
 * the number is measured rather than chosen. Taking the query that failed in
 * production — "list events from primary calendar between two dates, ordered
 * by start time descending, include max results", against `googlecalendar` —
 * and sweeping its prefixes:
 *
 *   2-3 words  10 results, `GOOGLECALENDAR_EVENTS_LIST` among them
 *   4-6 words   1 result
 *   7+ words    NOTHING, all the way to the full sentence
 *
 * Four other long queries behave the same way: full sentence 0 or 1 result,
 * first three words 1 to 8. So the catalogue does hold what was asked for and
 * the question was simply too long to match.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Which models write short queries is not
 * uniform. A GPT-5 agent asked for its calendar wrote the sentence above and
 * was told the catalogue has nothing for `googlecalendar` — with the calendar
 * connected and `GOOGLECALENDAR_EVENTS_LIST` sitting there. A Claude agent
 * asked the same question in three words and found it first time. Without this
 * retry, "connected apps work" quietly means "connected apps work on some
 * models", which is not something a person could ever debug from the outside.
 *
 * Only ever a second attempt, and only when the first found nothing: a search
 * that worked is never second-guessed.
 */
const RETRY_WORDS = 3;

/** The first `n` words, or the whole thing if it is already shorter. */
function firstWords(query: string, n: number): string {
  const words = query.split(/\s+/).filter(Boolean);
  return words.length <= n ? query : words.slice(0, n).join(" ");
}

/** One candidate, in the two or three lines a model needs to choose it. */
function summarise(tool: ComposioTool, connection: ToolConnection | undefined): string {
  const lines = [`${tool.slug} — ${tool.description || tool.name}`];
  if (connection) {
    lines.push(`  app: ${tool.toolkit} · connectionId: ${connection.id} (${connection.label})`);
  } else {
    // Carrying the next action in words, because `connectionsManifest` ends
    // with "never guess an id that is not on this list" and a model that finds
    // a slug with no connection id beside it will otherwise invent a uuid.
    lines.push(
      `  app: ${tool.toolkit} — NOT CONNECTED. You cannot run this. Ask the person to ` +
        `connect ${tool.toolkit} on the Integrations page.`,
    );
  }
  if (tool.required.length > 0) lines.push(`  needs: ${tool.required.join(", ")}`);
  // Said only when Composio said it. See `ComposioTool.destructive`: null is
  // the common answer and nothing branches on it, but a person reading the
  // approval card is better off knowing.
  if (tool.destructive === true) lines.push("  changes something at the service");
  return lines.join("\n");
}

export const findToolTool: AgentTool = {
  name: "find_tool",
  description:
    "Search a catalogue of operations across about 1500 applications — Gmail, HubSpot, " +
    "Linear, Notion and the rest — to find one that does what you need. Describe the " +
    "action in your own words. You get back candidate operation slugs, and for each one " +
    "either the connection id to run it with or a note that the app is not connected " +
    "here. Call this before run_tool; you cannot guess a slug. Ask for detail once you " +
    "know which operation you want and need its exact arguments.",
  input: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you are trying to do, in TWO OR THREE WORDS: 'send email', 'list events', " +
          "'create issue'. This is matched against operation names, not read as a sentence — " +
          "a full sentence describing what you want matches nothing at all. Put the detail in " +
          "run_tool's arguments instead, where it belongs.",
      },
      toolkit: {
        type: "string",
        description:
          "Narrow to one application by its slug — gmail, hubspot, linear. Use the toolkit " +
          "named beside a connection in the list of connected services.",
      },
      detail: {
        type: "boolean",
        description:
          "Return the full argument schema instead of a list. Use it when you know which " +
          "operation you want and need to know what to send. The other matches still come " +
          "back as one-liners underneath, so you never have to search again to change your " +
          "mind.",
      },
      slug: {
        type: "string",
        description:
          "With detail: the exact operation to describe, copied from an earlier result — " +
          "GOOGLECALENDAR_EVENTS_LIST. Name it rather than hoping the search ranks it first. " +
          "Without this, detail describes the top match.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  destructive: false,
  // No `needs`: the point of a catalogue-wide search is that it answers before
  // anything is connected. See the note at the top of this file.
  isConfigured: (env: ToolEnv) => composioConfigured(env),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as {
      query?: unknown;
      toolkit?: unknown;
      detail?: unknown;
      slug?: unknown;
    };
    if (typeof input.query !== "string" || !input.query.trim()) {
      return { kind: "error", message: "query is required — say what you are trying to do" };
    }
    const toolkit =
      typeof input.toolkit === "string" && input.toolkit.trim()
        ? input.toolkit.trim().toLowerCase()
        : undefined;

    // Before the network, because a search is billable and an exhausted
    // account must not be able to spend on one. See `lib/harness/spend.ts` for
    // why this is asked here rather than by the route.
    const refused = await affordable(ctx);
    if (refused) return refused;

    const query = input.query.trim();
    let found = await searchTools(
      ctx.env,
      { search: query, toolkit, limit: MAX_RESULTS * 2 },
      { signal: ctx.signal },
    );

    // Nothing matched, and a sentence is the likeliest reason. Try again with
    // the first few words before believing it. See `RETRY_WORDS`.
    const shorter = firstWords(query, RETRY_WORDS);
    if (found.kind === "ok" && found.tools.length === 0 && shorter !== query) {
      found = await searchTools(
        ctx.env,
        { search: shorter, toolkit, limit: MAX_RESULTS * 2 },
        { signal: ctx.signal },
      );
    }

    // Charged once, however many requests that took. The second one exists
    // because our own interface handed the catalogue something it cannot
    // match, and billing somebody twice for that is billing them for our
    // brittleness.
    if (found.kind === "ok" || wasBilled(found.status)) {
      await spend(ctx, COMPOSIO_SEARCH_TOKENS);
    }
    if (found.kind === "error") {
      return { kind: "error", message: `the catalogue could not be searched: ${found.message}` };
    }
    if (found.tools.length === 0) {
      return {
        kind: "ok",
        content:
          `No operation in the catalogue matches "${input.query.trim()}"` +
          `${toolkit ? ` in ${toolkit}` : ""}. Try different words, or tell the person this ` +
          "is not something you can do.",
      };
    }

    // Which of these the workspace could actually run. Through the caller's own
    // client, so a connection in another workspace was never in the list — and
    // filtered to `active` by `listConnections`, so a half-finished consent
    // screen is not offered as a connection id.
    const connections = await listConnections(ctx.db, ctx.workspaceId).catch(() => []);
    const byToolkit = new Map<string, ToolConnection>();
    for (const c of connections) {
      if (c.transport === "composio" && c.toolkit_slug && !byToolkit.has(c.toolkit_slug)) {
        byToolkit.set(c.toolkit_slug, c);
      }
    }

    // Connected applications first. Not a cosmetic sort: the model reads in
    // order, and a list whose first entry is an operation nobody can run is a
    // list that invites a call that cannot succeed.
    const ranked = [...found.tools].sort((a, b) => {
      const ac = byToolkit.has(a.toolkit) ? 0 : 1;
      const bc = byToolkit.has(b.toolkit) ? 0 : 1;
      return ac - bc;
    });

    if (input.detail === true) {
      // Which operation to describe, and why the model gets to say.
      //
      // This used to be `ranked[0]` and nothing else, which is the shape that
      // sent a production turn round in circles: asked for "list events" in a
      // calendar, the catalogue ranks GOOGLECALENDAR_EVENTS_GET above
      // GOOGLECALENDAR_EVENTS_LIST, so `detail` answered with the schema of an
      // operation whose own description says it does NOT list events. With the
      // other candidates gone from the answer there was nothing to pivot to,
      // so the model searched again in different words — four times in one
      // turn, spending the budget without ever calling anything.
      //
      // A slug the model has already seen therefore beats the ranking, because
      // the ranking is what went wrong.
      const named = typeof input.slug === "string" ? input.slug.trim().toUpperCase() : "";
      const chosen = named || ranked[0].slug;

      const full = await getTool(ctx.env, chosen, { signal: ctx.signal });
      if (full.kind === "ok" || wasBilled(full.status)) {
        await spend(ctx, COMPOSIO_SEARCH_TOKENS);
      }
      if (full.kind === "error") {
        return { kind: "error", message: `${chosen} could not be described: ${full.message}` };
      }
      const schema = full.tool.inputSchema
        ? JSON.stringify(full.tool.inputSchema, null, 2).slice(0, MAX_SCHEMA_CHARS)
        : "(this operation publishes no argument schema)";

      // And the rest of the shortlist, in one line each. Cheap — they were
      // already fetched — and it is the half that was missing: a model handed
      // the wrong operation can now take the right one instead of searching
      // again for it.
      const others = ranked.filter((t) => t.slug !== full.tool.slug).slice(0, MAX_RESULTS - 1);
      const alternatives =
        others.length > 0
          ? `\n\nIf that is not the one you want, these also matched — ask for detail on a ` +
            `slug by name rather than searching again:\n` +
            others.map((t) => `  ${t.slug} — ${t.description || t.name}`).join("\n")
          : "";

      return {
        kind: "ok",
        content:
          `${summarise(full.tool, byToolkit.get(full.tool.toolkit))}\n\n` +
          `Arguments:\n${schema}${alternatives}`,
      };
    }

    const listed = ranked
      .slice(0, MAX_RESULTS)
      .map((tool) => summarise(tool, byToolkit.get(tool.toolkit)))
      .join("\n\n");

    return {
      kind: "ok",
      content:
        `${listed}\n\nRun one with run_tool, giving its connectionId and slug. Call this ` +
        "again with detail: true if you need the exact arguments.",
    };
  },
};
