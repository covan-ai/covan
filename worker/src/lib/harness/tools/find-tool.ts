import { composioConfigured, getTool, searchTools, type ComposioTool } from "../../composio/client";
import { COMPOSIO_SEARCH_TOKENS } from "../../entitlements";
import { listConnections, unavailableTools, type ToolConnection } from "../connections";
import { cap } from "../budget";
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

/**
 * How many parameter names an alternative is allowed to list.
 *
 * Names are short and a wide operation is rare; this is a ceiling against the
 * one with ninety, not a budget anybody is expected to reach.
 */
const MAX_PARAM_NAMES = 24;

/**
 * How much of an operation's own description a candidate line may spend.
 *
 * Composio publishes some very long ones — WIX_MCP_SEARCH_WIX_API_SPEC's runs
 * to 3,100 characters — and five of those are the whole answer, cut off by
 * MAX_TOOL_OUTPUT_CHARS before the model reaches the candidate it wanted.
 * Render-only: the object handed to `remember()` keeps its whole text, because
 * the approval card a person reads is built from that.
 */
const MAX_DESCRIPTION_CHARS = 240;

/**
 * One line of description, cut at a sentence if there is one to cut at.
 *
 * Not `cap()`: its 50-character notice is longer than what it would be saying
 * about, on a one-liner. `cap` is for the schema, where the size matters.
 */
function brief(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const head = text.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSentence = head.search(/\.(?=\s)(?![\s\S]*\.(?=\s))/);
  if (lastSentence > MAX_DESCRIPTION_CHARS / 2) return head.slice(0, lastSentence + 1);
  return `${head.trimEnd()}…`;
}

/** How many arguments the operation publishes, before `MAX_PARAM_NAMES` cuts. */
function parameterCount(tool: ComposioTool): number {
  const properties = tool.inputSchema?.properties;
  if (typeof properties !== "object" || properties === null) return 0;
  return Object.keys(properties).length;
}

/**
 * Words too common to tell two operations apart.
 *
 * Short and deliberately not a general stop-word list: every entry here is a
 * word that appears in a Composio slug often enough that matching on it says
 * nothing. `GOOGLECALENDAR_EVENTS_LIST` and `GOOGLECALENDAR_EVENTS_GET` both
 * contain `EVENTS`; a query saying "get the event" should be separated by
 * `GET`, not tied by `EVENT`.
 */
const UNHELPFUL_WORDS = new Set(["a", "an", "the", "for", "from", "of", "in", "on", "to", "my"]);

/** `EVENTS` and `EVENT` are the same word for this purpose. Nothing more clever. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The words of a query that are worth comparing against anything. */
function meaningfulWords(query: string): Set<string> {
  const out = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || UNHELPFUL_WORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * How many of the query's own words this operation's name actually contains.
 *
 * WHY THIS EXISTS. On 2026-09-26 a person asked an agent to delete a few
 * recurring events. `find_tool` was called with "delete event google calendar"
 * and Composio ranked `GOOGLECALENDAR_CLEAR_CALENDAR` — *"clears a primary
 * calendar by deleting all events from it"* — **above**
 * `GOOGLECALENDAR_DELETE_EVENT`. The model read in order, took the first, and
 * emptied a real calendar. #201.
 *
 * WHY IT IS NOT A BLAST-RADIUS RULE. #201 considered de-ranking operations that
 * act on everything and declined, for a reason that still holds: every such
 * rule is a string match on vendor description prose, and one that de-ranks the
 * *correct* operation trades this failure for a new one. This rule never asks
 * what an operation does. It asks how much of the question the operation's own
 * name answers — `DELETE` ✓ `EVENT` ✓ against nothing — so it cannot mislabel a
 * safe operation as dangerous, and the worst it can do is reorder two equally
 * good candidates.
 *
 * Scored against the slug's segments rather than the raw string, so `EVENT` is
 * a word and not a substring of something else.
 *
 * WORDS NAMING THE APPLICATION SCORE NOTHING, and that is the part that makes
 * this work rather than backfire. Every slug opens with its toolkit —
 * `GOOGLECALENDAR_…` — and a person's query usually names the application too,
 * so `calendar` is inside every candidate in a Google Calendar result. Left in,
 * it hands `CLEAR_CALENDAR` a point for being in the application it is in,
 * which is the opposite of telling two candidates apart. Judged per candidate
 * rather than once for the query, because the candidates can come from
 * different applications and a word is only uninformative about its own.
 */
function relevance(tool: ComposioTool, words: Set<string>): number {
  if (words.size === 0) return 0;
  const app = tool.toolkit.toLowerCase();
  const segments = new Set(tool.slug.toLowerCase().split("_").map(stem));
  let score = 0;
  for (const word of words) {
    // `google` and `calendar` are both inside `googlecalendar`, which is how a
    // toolkit slug is spelled — so this is a containment test, not equality.
    if (app.includes(word)) continue;
    if (segments.has(word)) score += 1;
  }
  return score;
}

/**
 * How many connected applications get asked the question in their own right.
 *
 * A ceiling on requests per search, not a judgement about how many connections a
 * workspace should have. Four covers every workspace on the install today with
 * room over; past that the catalogue-wide search is still doing its job and the
 * `toolkit` argument is the honest answer for a model that knows which
 * application it wants.
 */
const MAX_CONNECTED_SEARCHES = 4;

/**
 * An operation's parameter names, for the candidates that get no schema.
 *
 * `summarise` prints `needs:`, which is the required ones, and that is not the
 * same question. Measured in production on 2026-09-26:
 * `GOOGLECALENDAR_CREATE_EVENT` requires only `start_datetime`, so `needs:`
 * alone still would not have named `timezone` — and Composio defaults that
 * parameter to UTC when it is absent, which put five events on a real calendar
 * three hours from where they were asked for (#192).
 *
 * Names **and one word of type**, never descriptions or nested schemas. A full
 * schema for every candidate is exactly what `MAX_SCHEMA_CHARS` exists to
 * prevent, and this is not one: it is `name: string`, five to eight characters,
 * with no enum, no nested object and no prose. Free, too: the schemas arrive
 * with the search, which is how `required` is populated at all.
 *
 * WHY THE TYPE IS WORTH THOSE CHARACTERS. This printed names alone until
 * 2026-09-28, on the argument that a name is enough both to call the operation
 * and to know it is the wrong one. The first half of that is false, and
 * production said so: the model was told an argument was called `attendees`,
 * was never told it was a string, passed an array of strings, and got back
 * `Input should be a valid string on parameter 'attendees.0'`. Same shape for
 * `recursive`. A refused call costs a step out of eight, a round trip, and a
 * Composio charge — `lib/harness/spend.ts` bills everything but 501 and 502 —
 * to learn one word that could have been in the line above it.
 */
function parameterNames(tool: ComposioTool): string[] {
  const properties = tool.inputSchema?.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const bag = properties as Record<string, unknown>;
  const required = new Set(tool.required);
  // Required first, because a model reading a truncated list should meet the
  // parameters it cannot omit.
  const names = Object.keys(bag).sort((a, b) => {
    const ar = required.has(a) ? 0 : 1;
    const br = required.has(b) ? 0 : 1;
    return ar - br;
  });
  return names.slice(0, MAX_PARAM_NAMES).map((name) => {
    const type = parameterType(bag[name]);
    const labelled = type ? `${name}: ${type}` : name;
    return required.has(name) ? `${labelled} (required)` : labelled;
  });
}

/**
 * The one word from a parameter's schema that decides how to write it.
 *
 * `null` when the schema does not say — a `oneOf`, an untyped object, a
 * catalogue entry with no `inputSchema` at all. The caller falls back to the
 * bare name rather than guessing, because a wrong type is worse than no type:
 * it would be followed confidently.
 *
 * Arrays print their element type (`string[]`) because that is the distinction
 * the failures were actually about — a string handed where a list was wanted,
 * or the reverse. Nesting stops there; anything deeper is what `detail` and
 * `MAX_SCHEMA_CHARS` are for.
 */
function parameterType(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null) return null;
  const raw = (schema as { type?: unknown }).type;
  const name =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? // A nullable parameter arrives as ["string","null"]. The null carries
          // nothing a caller can act on, so it is dropped rather than printed.
          raw.filter((t): t is string => typeof t === "string" && t !== "null").join("|")
        : "";
  if (!name) return null;
  if (name !== "array") return name;
  const inner = parameterType((schema as { items?: unknown }).items);
  return inner ? `${inner}[]` : "array";
}

/**
 * Hand a candidate to `run_tool` whole, so a malformed call is refused here
 * rather than bought from Composio and the approval card can say what the
 * operation does. See `ToolContext.offeredOperations` — same provenance rule as
 * `offeredSlugs`, written in the same places.
 */
function remember(ctx: ToolContext, tool: ComposioTool): void {
  ctx.offeredOperations?.set(tool.slug, tool);
}

/**
 * One candidate, in the two or three lines a model needs to choose it.
 *
 * `opts.parameters` prints every argument by name rather than the required
 * ones alone, which is what lets `run_tool` be called straight from a search.
 * Asked for on the first connected candidate only: the names are free — the
 * schemas arrive with the search — but five full argument lists is the answer
 * being spent on candidates nobody chose.
 */
function summarise(
  tool: ComposioTool,
  connection: ToolConnection | undefined,
  opts?: { parameters?: boolean },
): string {
  const lines = [`${tool.slug} — ${brief(tool.description || tool.name)}`];
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
  const named = opts?.parameters ? parameterNames(tool) : [];
  if (named.length > 0) {
    // Instead of `needs:`, not beside it — the `(required)` markers carry
    // everything `needs:` was saying.
    const hidden = parameterCount(tool) - named.length;
    const more = hidden > 0 ? `, … (+${hidden} more — ask for detail)` : "";
    lines.push(`  takes: ${named.join(", ")}${more}`);
  } else if (tool.required.length > 0) {
    // Typed for the same reason `takes:` is: this is the line most candidates
    // actually get, and `needs: operations` was what preceded the malformed
    // call that started all this. Falls back to the bare name where the
    // catalogue entry carries no schema to read a type off.
    const properties = tool.inputSchema?.properties;
    const bag = (typeof properties === "object" && properties !== null ? properties : {}) as Record<
      string,
      unknown
    >;
    const needed = tool.required.map((name) => {
      const type = parameterType(bag[name]);
      return type ? `${name}: ${type}` : name;
    });
    lines.push(`  needs: ${needed.join(", ")}`);
  }
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
    "here. The first candidate also lists its arguments by name, so in the usual case " +
    "one search is enough and run_tool comes next. Call this before run_tool; you " +
    "cannot guess a slug. Ask for detail only when you need a particular argument's " +
    "type or allowed values.",
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
          "Return the full argument schema instead of a list. You rarely need it: the " +
          "first candidate of an ordinary search already names every argument it takes " +
          "and marks the required ones. Ask for this when you need an argument's TYPE or " +
          "its allowed values. The other matches still come back as one-liners " +
          "underneath, so you never have to search again to change your mind.",
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

    const query = input.query.trim();
    const named = typeof input.slug === "string" ? input.slug.trim().toUpperCase() : "";
    // What the model actually asked for, in the form the ranking below compares
    // against. Read from the query it typed rather than from the shortened
    // retry, because the retry is a workaround for the catalogue's matching and
    // the full question is the better statement of intent.
    const queryWords = meaningfulWords(query);

    // The same search, asked twice in one turn. Answered from what it said the
    // first time, and said so — see `searchMemo` in `registry.ts` for the
    // production turn that made this worth having. Before `affordable`,
    // because nothing is about to be bought.
    const memoKey = `${toolkit ?? ""}|${input.detail === true ? "detail" : "list"}|${named}|${query.toLowerCase()}`;
    const remembered = ctx.searchMemo?.get(memoKey);
    if (remembered !== undefined) {
      return {
        kind: "ok",
        content:
          "You already ran this exact search earlier in this turn. Here is what it said — " +
          "choose an operation from it and call run_tool, or ask for detail on a slug by " +
          `name. Searching again will keep giving you this.\n\n${remembered}`,
      };
    }

    // Before the network, because a search is billable and an exhausted
    // account must not be able to spend on one. See `lib/harness/spend.ts` for
    // why this is asked here rather than by the route.
    const refused = await affordable(ctx);
    if (refused) return refused;

    // Which of these the workspace could actually run. Through the caller's own
    // client, so a connection in another workspace was never in the list — and
    // filtered to `active` by `listConnections`, so a half-finished consent
    // screen is not offered as a connection id.
    //
    // Read before the search rather than after it, because on a catalogue-wide
    // query it decides what gets searched. See `connectedSearches` below.
    const connections = await listConnections(ctx.db, ctx.workspaceId).catch(() => []);
    const byToolkit = new Map<string, ToolConnection>();
    for (const c of connections) {
      if (c.transport === "composio" && c.toolkit_slug && !byToolkit.has(c.toolkit_slug)) {
        byToolkit.set(c.toolkit_slug, c);
      }
    }

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

    // The same question, asked of each connected application by name.
    //
    // Composio's catalogue answers alphabetically, so a catalogue-wide search
    // holding ten results never reaches the g's — four production turns on
    // 2026-09-26 searched "create event" against a workspace with Google
    // Calendar connected, got `_2chat` and `active_campaign`, and told the
    // person there was no calendar. The connected-first sort below cannot reach
    // that: it reorders the rows that came back, and the connected application
    // was never among them.
    //
    // Only when the model named no toolkit — having named one it has already
    // done what this compensates for — and only when the broad search surfaced
    // nothing the workspace can run. A search that already found a connected
    // operation is not the failure this exists for, and re-asking it would spend
    // requests on every search to fix the ones that come back empty-handed.
    //
    // In parallel, because these are independent reads and a search has been
    // measured at three seconds. Charged once for all of it, like the short
    // retry above and for the same reason: the extra requests exist because our
    // own search cannot see what the workspace connected, and charging for that
    // is charging somebody for our shape.
    const broadTools = found.kind === "ok" ? found.tools : [];
    const foundSomethingRunnable = broadTools.some((t) => byToolkit.has(t.toolkit));
    const connectedSearches: ComposioTool[] = [];
    if (!toolkit && byToolkit.size > 0 && !foundSomethingRunnable) {
      const slugs = [...byToolkit.keys()].slice(0, MAX_CONNECTED_SEARCHES);
      const answers = await Promise.all(
        slugs.map((slug) =>
          searchTools(
            ctx.env,
            { search: query, toolkit: slug, limit: MAX_RESULTS },
            { signal: ctx.signal },
          ),
        ),
      );
      for (const answer of answers) {
        if (answer.kind === "ok") connectedSearches.push(...answer.tools);
      }
    }

    // Charged once, however many requests that took. The second one exists
    // because our own interface handed the catalogue something it cannot
    // match, and billing somebody twice for that is billing them for our
    // brittleness.
    if (found.kind === "ok" || wasBilled(found.status)) {
      await spend(ctx, COMPOSIO_SEARCH_TOKENS);
    }

    /**
     * What the connected accounts have already proven they cannot run.
     *
     * Free: `listConnections` above already selected `config`, which is where
     * this is kept, so filtering costs no query. Keyed by toolkit because that
     * is what a candidate carries — the connection behind a toolkit is the one
     * whose account answered the 404.
     *
     * This is the largest failure class in the harness. `find_tool` searches
     * Composio's whole catalogue, a connected account has a subset of it, and
     * there is no parameter on `/api/v3.1/tools` that names an account — so the
     * catalogue happily offers operations execution cannot run, and twenty of
     * the thirty `run_tool` failures ever recorded are exactly that. See
     * `unavailableTools`.
     */
    const deadByToolkit = new Map<string, Set<string>>();
    for (const [toolkitSlug, connection] of byToolkit) {
      const dead = unavailableTools(connection);
      if (dead.size > 0) deadByToolkit.set(toolkitSlug, dead);
    }

    // What the workspace can run, then the rest of the catalogue, deduplicated.
    const seen = new Set<string>();
    const candidates: ComposioTool[] = [];
    let withheld = 0;
    for (const tool of [...connectedSearches, ...broadTools]) {
      if (seen.has(tool.slug)) continue;
      seen.add(tool.slug);
      // Dropped rather than ranked last. A list whose entries include one the
      // connection is known to refuse is a list that invites a call which
      // cannot succeed — the same argument the connected-first sort below makes,
      // and here we have proof rather than a guess.
      if (deadByToolkit.get(tool.toolkit)?.has(tool.slug)) {
        withheld += 1;
        continue;
      }
      candidates.push(tool);
    }

    // The catalogue-wide search failing is only fatal if nothing else answered.
    // A connected application that did is a better answer than its error.
    if (candidates.length === 0 && found.kind === "error") {
      return { kind: "error", message: `the catalogue could not be searched: ${found.message}` };
    }
    if (candidates.length === 0) {
      // Said out loud when the filter is what emptied the list, because
      // "the catalogue does not have it" and "your account does not have it"
      // call for different things from the person being talked to.
      if (withheld > 0) {
        return {
          kind: "ok",
          content:
            `Every operation matching "${input.query.trim()}"` +
            `${toolkit ? ` in ${toolkit}` : ""} is one this workspace's connected account has ` +
            "already been shown not to have. The catalogue lists them; the connection cannot " +
            "run them. Tell the person this needs a broader authorisation on that app, or " +
            "search for a genuinely different operation.",
        };
      }
      return {
        kind: "ok",
        content:
          `No operation in the catalogue matches "${input.query.trim()}"` +
          `${toolkit ? ` in ${toolkit}` : ""}. The short retry above has already been tried, ` +
          "so the catalogue most likely does not have it. Tell the person this is not " +
          "something you can do, or name a different application. Search again only for a " +
          "genuinely different operation, not for the same one in other words.",
      };
    }

    // Connected applications first. Not a cosmetic sort: the model reads in
    // order, and a list whose first entry is an operation nobody can run is a
    // list that invites a call that cannot succeed.
    //
    // Then, within one application, the operation whose name answers more of
    // the question. Second and never first: connectedness is a fact about what
    // can run, relevance is a judgement about what was meant, and a judgement
    // must not be able to lift an operation nobody can call. See `relevance`
    // for the calendar somebody lost to the old order.
    //
    // A stable sort, so a tie is left exactly as the catalogue returned it —
    // when nothing scores, this whole comparison is a no-op and the order is
    // Composio's, which is the right thing for it to degrade to.
    const ranked = [...candidates].sort((a, b) => {
      const ac = byToolkit.has(a.toolkit) ? 0 : 1;
      const bc = byToolkit.has(b.toolkit) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return relevance(b, queryWords) - relevance(a, queryWords);
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
      const chosen = named || ranked[0].slug;

      const full = await getTool(ctx.env, chosen, { signal: ctx.signal });
      if (full.kind === "ok" || wasBilled(full.status)) {
        await spend(ctx, COMPOSIO_SEARCH_TOKENS);
      }
      if (full.kind === "error") {
        return { kind: "error", message: `${chosen} could not be described: ${full.message}` };
      }
      const schema = full.tool.inputSchema
        ? // `cap`, not a bare slice: a schema cut mid-JSON with nothing saying
          // so reads as an operation with three arguments rather than one whose
          // list was truncated, and the model then calls it with three.
          cap(JSON.stringify(full.tool.inputSchema, null, 2), MAX_SCHEMA_CHARS)
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
            others
              .map((t) => {
                const params = parameterNames(t);
                const takes = params.length > 0 ? `\n    takes: ${params.join(", ")}` : "";
                return `  ${t.slug} — ${brief(t.description || t.name)}${takes}`;
              })
              .join("\n")
          : "";

      const detailed =
        `${summarise(full.tool, byToolkit.get(full.tool.toolkit))}\n\n` +
        `Arguments:\n${schema}${alternatives}`;
      ctx.searchMemo?.set(memoKey, detailed);
      // What the model was actually shown, which is what `run_tool` is allowed
      // to run. The alternatives count: they are in the answer by name, so a
      // model that takes one of them is following this tool's own advice.
      ctx.offeredSlugs?.add(full.tool.slug);
      remember(ctx, full.tool);
      for (const t of others) {
        ctx.offeredSlugs?.add(t.slug);
        remember(ctx, t);
      }
      return { kind: "ok", content: detailed };
    }

    const shortlist = ranked.slice(0, MAX_RESULTS);
    for (const tool of shortlist) {
      ctx.offeredSlugs?.add(tool.slug);
      remember(ctx, tool);
    }
    const listed = shortlist
      .map((tool, i) =>
        summarise(tool, byToolkit.get(tool.toolkit), {
          // The first candidate only, and only when it can actually be run:
          // naming the arguments of something nobody can reach invites a call
          // that cannot succeed.
          parameters: i === 0 && byToolkit.has(tool.toolkit),
        }),
      )
      .join("\n\n");

    const answer =
      `${listed}\n\nRun one with run_tool, giving its connectionId and slug. The first ` +
      "entry's arguments are listed above; ask for detail on a slug by name only if you " +
      "need an argument's type or allowed values.";
    // Remembered only when it found something. A turn that searched and got
    // nothing should be free to try again with different words — that is the
    // useful kind of repeat, and the retry above already depends on it.
    ctx.searchMemo?.set(memoKey, answer);
    return { kind: "ok", content: answer };
  },
};
