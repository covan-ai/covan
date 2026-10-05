import { meteredFetch, type SubrequestMeter } from "../subrequests";
/**
 * Composio's API, as much of it as Covan needs and no more.
 *
 * Seven entry points: search the catalogue, read one operation's schema, run
 * one, list the applications, start a consent flow, ask how one ended, and
 * revoke it. Everything else Composio sells — their toolset, their agent
 * framework adapters, their execution middleware — is deliberately not here.
 *
 * WHAT IS BOUGHT AND WHAT IS NOT. Bought: a registered OAuth application per
 * provider, and a machine-readable description of each provider's operations.
 * Those are the two halves `tool_connections` (0059) has never had and that no
 * amount of code in this repository could supply. Not bought: dispatch. Their
 * toolset puts a service's schemas into every turn's tool array, which cannot
 * scale past a handful of applications and would retire the origin lock, the
 * method allowlist, the step budget and the confirmation gate that
 * `lib/harness/` already enforces. The call is made from
 * `lib/harness/tools/run-tool.ts`, under all of those.
 *
 * WHY PLAIN `fetch` AND NOT THE SDK. `lib/connections/notion.ts`'s reason, one
 * layer down: both runtimes have to keep working, the SDK is built for Node,
 * and what we use is four JSON endpoints. `fetchImpl` is injectable so the
 * tests do not stub a global.
 *
 * WHY TWO API VERSIONS. The catalogue moved to `/api/v3.1` and execution did
 * not. Both are constants in this one file so the day that split closes is one
 * edit rather than a search.
 *
 * FAILURES ARE RETURNED, NOT THROWN, for the reason `lib/supabase-management.ts`
 * gives: every caller is either a route rendering a form or a tool writing a
 * sentence for a model, and both need a message rather than an exception.
 */

/** Where the hosted API lives. Overridable per deployment, never per row. */
export const COMPOSIO_BASE = "https://backend.composio.dev";

/** The catalogue half. Tools and toolkits moved here; execution did not. */
const CATALOGUE_API = "/api/v3.1";

/** Execution, connected accounts, and the consent flow. */
const CORE_API = "/api/v3";

/** Long enough for a cold catalogue read, short enough to fail a form politely. */
const TIMEOUT_MS = 15_000;

/** Enough of an error body to diagnose, not enough to fill a log line. */
const MAX_ERROR_CHARS = 2_000;

/**
 * What a tool call may bring back before it is refused.
 *
 * The harness caps again at `MAX_TOOL_OUTPUT_CHARS`; this caps the read itself,
 * which on a streaming runtime is the difference between a cap and no cap at
 * all. Same number `http_request` uses, for the same reason.
 */
const MAX_BYTES = 256 * 1024;

/**
 * What a CATALOGUE page may weigh before the read is abandoned.
 *
 * A different question from `MAX_BYTES` above, even though that number shipped as
 * the answer to both. `MAX_BYTES` caps a body a THIRD PARTY chose the size of, on
 * its way to a model that will be shown twelve thousand characters of it. This
 * caps a document we asked for BY THE ROW — `searchTools` sends `limit`, so the
 * size is ours, and the only thing a cap can decide here is whether a page we
 * deliberately asked for arrives whole.
 *
 * WHY 256KB STOPPED BEING ENOUGH. A catalogue row carries the operation's whole
 * argument schema — that is how `find_tool` names an operation's parameters
 * without a second request — and the widest rows are large. Fifty of them can pass
 * 256KB, and past the cap the body arrives cut, `JSON.parse` fails, `parsed`
 * answers null, `rows(null)` is `[]`, and the caller used to be handed
 * `{kind:"ok", tools:[]}` — which `find_tool` reports as "no operation in the
 * catalogue matches". A page too big to read was indistinguishable from an empty
 * catalogue. `routes/composio.ts` already chose a page of ten to stay clear of it.
 *
 * A megabyte is twenty kilobytes a row at the largest page this file will ask for.
 * It costs one string and one `JSON.parse` in an isolate with 128MB, and nothing in
 * any budget that binds: no extra subrequest, no extra charge, and nothing in the
 * prompt — the page is read to be RANKED, and `find_tool` shows five of it.
 */
const MAX_CATALOGUE_BYTES = 1024 * 1024;

/**
 * The largest page this file will ask the catalogue for.
 *
 * Fifty, and it is OUR ceiling rather than a documented one. Nothing here has
 * established what `/api/v3.1/tools` honours above it — the sibling clamp in
 * `listToolkits` is a hundred only because a hundred was seen to work on
 * `/toolkits`. So fifty is what a caller may rely on, and raising it is a live
 * probe away rather than a guess away.
 */
export const MAX_TOOLS_PAGE = 50;

/**
 * The deployment's Composio credentials.
 *
 * Narrow on purpose rather than `Bindings`: this module is reached from the
 * cron Worker as well as the API one, and a type that claimed the rest would be
 * claiming bindings that Worker does not have.
 */
export type ComposioEnv = {
  COMPOSIO_API_KEY?: string;
  COMPOSIO_BASE_URL?: string;
  /** Request-scoped, and absent everywhere but a chat turn. See `lib/subrequests.ts`. */
  SUBREQUESTS?: SubrequestMeter;
};

export type ComposioOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type ComposioError = { kind: "error"; status: number; message: string };
export type ComposioResult<T> = ({ kind: "ok" } & T) | ComposioError;

/**
 * One operation in the catalogue.
 *
 * `inputSchema` is the JSON Schema Composio publishes for the operation's
 * arguments. It arrives on search rows too — `toTool` fills it from whichever
 * of the four field spellings the row carries — which is how `required` is
 * populated without a second request, and what lets `find_tool` name an
 * operation's arguments from a list. Null only when the row published none.
 *
 * `destructive` comes from MCP's tool annotation hints, which Composio does
 * carry — see `destructiveOf`. It is still `null` for operations annotated with
 * none of them, and that is a real answer rather than a failure. Nothing in the
 * permission model branches on it: it is shown to the person reading an
 * approval card, where "this one deletes things" is worth a line, and the model
 * is built to be correct without it.
 */
export type ComposioTool = {
  slug: string;
  name: string;
  description: string;
  /** The application it belongs to, lowercased: `gmail`, `linear`. */
  toolkit: string;
  /** Parameter names the operation requires, for a cheap one-line summary. */
  required: string[];
  inputSchema: Record<string, unknown> | null;
  destructive: boolean | null;
};

/**
 * What connecting an application actually requires.
 *
 * The question the Connect button should be asking, and for a long time it
 * asked a different one — whether either of two catalogue columns was set.
 * Those columns can prove two of these four and are silent about the other
 * two, which is how an application whose key the user supplies came to be
 * told it needed an OAuth client registered on its behalf.
 *
 * `needs_setup` is the only one that is a job rather than a flow: somebody has
 * to put something into Composio's dashboard before anybody can connect.
 */
export type ComposioConnectKind = "no_auth" | "managed_oauth" | "user_credential" | "needs_setup";

/**
 * Which kind of auth config a connect attempt needs at Composio.
 *
 * Derived by `authConfigPlanFor` from `connectKind` and `credentialScheme` and
 * from nothing else — the same two fields the card renders its sentence from.
 * That identity is the whole consistency guarantee between what a person is
 * promised and what gets built: the page cannot offer a button whose plan the
 * worker would refuse, because both are reading one value.
 */
/**
 * **There is no `no_auth` member, and its absence is the fix for covan#253.**
 * Such a toolkit has no auth config, no connected account and no link — so a
 * plan for one is not a plan Composio can execute, and this type saying so
 * makes the dead end unrepresentable rather than a branch somebody has to
 * remember. The route asks `connectsWithoutAccount` first and never reaches
 * `createLink` for one.
 */
export type AuthConfigPlan =
  { kind: "managed_oauth" } | { kind: "user_credential"; scheme: string };

/** One application, as the catalogue lists it. */
export type ComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  /** How the provider can be authorised at all: `OAUTH2`, `API_KEY`, … */
  authSchemes: string[];
  /**
   * Whether Composio has an OAuth application of its own for this provider.
   *
   * A raw catalogue column, and **not** the answer to whether this can be
   * connected — `connectKind` is. False here used to mean "somebody has to
   * register a client with that provider", which is true of fifty toolkits and
   * was being said to one and a half thousand.
   */
  managedAuth: boolean;
  /**
   * Whether the provider needs no sign-in at all, as the catalogue's own
   * column says it.
   *
   * Another raw column, and a trap: **the detail endpoint does not carry it**,
   * so a row read by `getToolkit` has this false whatever the truth, and the
   * connect route has been reading exactly that. `connectKind` reads the
   * column *or* a `NO_AUTH` entry among the published modes, which is the one
   * predicate that works on either row. Measured 2026-10-05: the two name the
   * same thirty-five toolkits, so the union invents nothing.
   *
   * Thirty-four of those are connectable since covan#253 and 0072 — they get a
   * `composio_no_auth` row and no Composio artifact at all. The thirty-fifth is
   * `gemini`, which also publishes an API-key mode and is offered as a
   * credential application instead, because that is what most of its operations
   * need. `connectKind` is where that distinction lives; this column cannot
   * make it, which is one more reason not to gate on it.
   */
  noAuth: boolean;
  /**
   * What connecting this one requires — the authoritative field, and the only
   * one a gate should read.
   *
   * Null means *this row cannot say*, which is the honest answer for a
   * catalogue list row: it can prove no-sign-in and managed OAuth and is
   * silent about the rest. A detail row is always one of the four. The
   * nullability is what keeps the field truthful on both paths instead of
   * quietly empty on one.
   */
  connectKind: ComposioConnectKind | null;
  /**
   * Composio's own name for the credential mode chosen, empty unless
   * `connectKind` is `user_credential`.
   *
   * Carried so the card can name the noun it is asking somebody to go and
   * fetch — a key, or a username and password. Telling a person to paste an
   * API key into a field labelled password is the kind of thing `DESIGN.md`
   * opens with, and the scheme is the only thing that distinguishes them.
   */
  credentialScheme: string;
  /**
   * A page at the provider where the credential can be obtained, when the
   * catalogue publishes one. Empty otherwise.
   *
   * Non-empty on about a quarter of the applications this applies to, counted
   * 2026-10-05. For a flow whose entire failure mode is somebody wandering off
   * to find a key and not coming back, a link straight to the right page is
   * worth more than any amount of copy.
   */
  authHintUrl: string;
  /**
   * The application's own mark, as an address on a host we are willing to
   * fetch from — see `allowedLogoUrl`. Empty when the catalogue published none
   * or published one somewhere we do not follow.
   *
   * This is the UPSTREAM address and it is not what the browser is given.
   * `routes/composio.ts` rewrites it into a path on our own proxy, so a page
   * showing forty logos makes forty requests to Covan and none to Composio.
   */
  logo: string;
  /**
   * Category ids, which is what the catalogue filter speaks. Names are a
   * separate read (`listToolkitCategories`) because the same id arrives with a
   * different display name in different rows.
   */
  categories: string[];
};

/** One heading in the catalogue's own taxonomy. */
export type ComposioCategory = { id: string; name: string };

export type ConnectedAccountStatus = "pending" | "active" | "failed";

function baseOf(env: ComposioEnv): string {
  return (env.COMPOSIO_BASE_URL || COMPOSIO_BASE).replace(/\/+$/, "");
}

/**
 * Whether this deployment can talk to Composio at all.
 *
 * Exported so the tools and the routes ask the same question in the same
 * words — `available.ts`'s rule that chat and a schedule must never disagree
 * about what exists applies here as much as anywhere.
 */
export function composioConfigured(env: ComposioEnv): boolean {
  return Boolean(env.COMPOSIO_API_KEY);
}

/**
 * One request, with the API key and every guard the rest of this codebase puts
 * on an outbound call.
 *
 * No SSRF guard, deliberately, and it is worth saying why the omission is not
 * an oversight: the address is a deployment constant that no workspace, row or
 * model can influence, which is the precondition `lib/routines/url-guard.ts`
 * exists because `http_request` cannot meet. `resolvesPublicly` on a fixed
 * hostname on every call would be a DNS lookup per tool call to re-answer a
 * question about our own configuration.
 */
async function request(
  env: ComposioEnv,
  path: string,
  init: { method: string; body?: unknown; maxBytes?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ body: string }>> {
  if (!env.COMPOSIO_API_KEY) {
    return { kind: "error", status: 501, message: "this deployment has no COMPOSIO_API_KEY set" };
  }
  // A test's stub wins, then the counting wrapper, then the platform's own.
  // Composio is the most expensive call a turn makes and the one most likely to
  // be repeated, so leaving it out of the count would understate the half that
  // matters most. See `lib/subrequests.ts`.
  const doFetch = opts?.fetchImpl ?? meteredFetch(env) ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${baseOf(env)}${path}`, {
      method: init.method,
      headers: {
        // Composio's own scheme. Not `Authorization`, and not a header name
        // this codebase gets to choose.
        "x-api-key": env.COMPOSIO_API_KEY,
        Accept: "application/json",
        "User-Agent": "covan/1.0",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Every 3xx is an error, for `lib/routines/delivery.ts`'s reason: a
      // redirect is either a request to repeat a credentialed request at an
      // address we did not name, or a request to drop the body.
      redirect: "manual",
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "error",
      status: 502,
      message: err instanceof Error ? err.message : "could not reach Composio",
    };
  }

  if (res.status >= 300 && res.status < 400) {
    return { kind: "error", status: 502, message: `Composio answered ${res.status} redirect` };
  }

  const body = await readBody(res, init.maxBytes);

  if (res.status === 401 || res.status === 403) {
    return {
      kind: "error",
      status: res.status,
      message: "Composio did not accept this deployment's API key.",
    };
  }
  if (!res.ok) {
    // Composio's own sentence, forwarded rather than flattened. "unknown field
    // `recipient`" is what lets a model fix its next call; "the call failed" is
    // not. The same judgement `http_request` makes about a target's 400.
    return {
      kind: "error",
      status: res.status,
      message: body.slice(0, MAX_ERROR_CHARS) || `Composio answered ${res.status}`,
    };
  }

  return { kind: "ok", body };
}

/** The response text, capped, without reading an unbounded body first. */
async function readBody(res: Response, limit = MAX_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text().catch(() => "")).slice(0, limit);
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= limit) {
        await reader.cancel().catch(() => {});
        return out.slice(0, limit);
      }
    }
  } catch {
    return out;
  }
  return out;
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The array inside a paginated answer, whatever this endpoint calls it.
 *
 * Composio's list endpoints have spelled it `items` and `data` at different
 * versions and both are still in circulation. Reading either is two lines here
 * against a field name that would otherwise be load-bearing across a version
 * bump.
 */
function rows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["items", "data", "results", "tools", "toolkits"]) {
    const inner = value[key];
    if (Array.isArray(inner)) return inner.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Which application a tool belongs to, whichever shape the row uses.
 *
 * Composio has returned this as a string, as `{slug}`, and as `{name}`. The
 * slug is load-bearing — `run_tool` refuses a slug whose toolkit is not the
 * connection's own — so all three are read rather than one being assumed.
 * Failing that, the prefix of the tool slug itself: `GMAIL_SEND_EMAIL` names
 * its own toolkit, which is a convention rather than a promise and is therefore
 * the last resort and not the first.
 */
function toolkitOf(row: Record<string, unknown>, slug: string): string {
  const raw = row.toolkit ?? row.toolkit_slug ?? row.app ?? row.app_name;
  const named = isRecord(raw)
    ? text(raw.slug) || text(raw.name)
    : typeof raw === "string"
      ? raw
      : "";
  if (named) return named.toLowerCase();
  const prefix = slug.split("_")[0];
  return prefix ? prefix.toLowerCase() : "";
}

/**
 * Whether Composio says this operation changes something at the provider.
 *
 * It does say, and the vocabulary is MCP's tool annotation hints carried in
 * `tags`: `readOnlyHint`, `destructiveHint`, `createHint`, `updateHint`. Across
 * Gmail's 62 operations, `GMAIL_FETCH_EMAILS` carries `readOnlyHint` and
 * `GMAIL_DELETE_MESSAGE` carries `destructiveHint` — which is exactly the
 * distinction worth drawing. `null` is still a real answer: plenty of
 * operations carry none of the four.
 *
 * **Nothing in the permission model branches on this, deliberately.** A read at
 * a third party can pull private content into a turn as easily as a write can
 * change something, so "it only reads" is not a reason to skip asking. What
 * this buys is a line on the approval card, where knowing an operation deletes
 * things is worth having before you press the button.
 */
function destructiveOf(row: Record<string, unknown>): boolean | null {
  if (typeof row.is_destructive === "boolean") return row.is_destructive;
  if (typeof row.destructive === "boolean") return row.destructive;
  const tags = row.tags;
  if (Array.isArray(tags)) {
    const hints = new Set(
      tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()),
    );
    // `readOnlyHint` is checked first because it is the specific claim: an
    // operation carrying both it and a writing hint is being described by two
    // people, and the narrow statement is the one to believe.
    if (hints.has("readonlyhint")) return false;
    if (hints.has("destructivehint") || hints.has("createhint") || hints.has("updatehint")) {
      return true;
    }
  }
  return null;
}

/** The `required` list out of a JSON Schema, or an empty one. */
function requiredOf(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const required = schema.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [];
}

function schemaOf(row: Record<string, unknown>): Record<string, unknown> | null {
  const raw = row.input_parameters ?? row.inputParameters ?? row.parameters ?? row.input_schema;
  return isRecord(raw) ? raw : null;
}

function toTool(row: Record<string, unknown>): ComposioTool | null {
  const slug = text(row.slug) || text(row.name);
  if (!slug) return null;
  const schema = schemaOf(row);
  return {
    slug,
    name: text(row.display_name) || text(row.name) || slug,
    description: text(row.description),
    toolkit: toolkitOf(row, slug),
    required: requiredOf(schema),
    inputSchema: schema,
    destructive: destructiveOf(row),
  };
}

/**
 * Operations matching a description of what somebody wants to do.
 *
 * `limit` is what the caller gets to RANK, not what a model gets SHOWN, and the
 * two used to be nearly the same number. `find_tool` asked for ten and showed
 * five, which made Composio's own relevance the only thing deciding whether the
 * right operation was reachable at all — see `SEARCH_PAGE` in
 * `lib/harness/tools/find-tool.ts` for the sixteen-step turn that cost. It now
 * asks for the whole page; what reaches the model is its business.
 *
 * AN UNREADABLE BODY IS AN ERROR, not an empty catalogue. It used to be the
 * latter and that is the quietest failure in this file: `parsed` answers null for
 * anything that is not JSON, `rows(null)` is `[]`, and the caller was handed
 * `{kind:"ok", tools:[]}` — which `find_tool` reports as "no operation in the
 * catalogue matches", having read nothing at all. A page cut at the read cap is
 * exactly that case, and a gateway's HTML error page is the other.
 */
export async function searchTools(
  env: ComposioEnv,
  query: { search: string; toolkit?: string; limit?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ tools: ComposioTool[] }>> {
  const params = new URLSearchParams({
    search: query.search,
    limit: String(Math.min(Math.max(query.limit ?? 10, 1), MAX_TOOLS_PAGE)),
  });
  if (query.toolkit) params.set("toolkit_slug", query.toolkit.toUpperCase());

  const res = await request(
    env,
    `${CATALOGUE_API}/tools?${params}`,
    { method: "GET", maxBytes: MAX_CATALOGUE_BYTES },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  if (body === null) {
    return {
      kind: "error",
      status: 502,
      message:
        `Composio's answer could not be read (${res.body.length} characters, ` +
        `${res.body.length >= MAX_CATALOGUE_BYTES ? "cut at the read cap" : "not JSON"})`,
    };
  }

  const tools = rows(body)
    .map(toTool)
    .filter((t): t is ComposioTool => t !== null);
  return { kind: "ok", tools };
}

/**
 * A toolkit's own operations, for a person deciding whether to connect it.
 *
 * WHY NOT `searchTools`. Its `search` is required, and that is load-bearing for
 * `find-tool.ts` — `RETRY_WORDS` re-asks with a shorter query when the first
 * finds nothing, which assumes a real query exists. Making it optional would let
 * a future caller silently search for nothing. This asks a different question
 * ("what can this application do") and leaves the agent's path alone.
 *
 * THE ROWS ARE FILTERED AGAIN HERE, and that is not belt and braces. The rule
 * `authConfigFor` states one function down applies exactly: *an API that ignores
 * a filter it does not know returns EVERYTHING*, and production has already
 * shown what everything looks like — a catalogue-wide search answers
 * alphabetically and comes back with `_2chat` and `active_campaign`
 * (`find-tool.ts`). Without this, a `toolkit_slug` Composio declined to honour
 * would put ActiveCampaign's operations on Gmail's card, which is the exact
 * shape `DESIGN.md`'s first failure mode forbids.
 *
 * `total` is null unless it can be *earned*, and there are two ways to earn it.
 * Composio's reference documents a `total_items` on this endpoint, so that is
 * read when it is there — but documented is not the same as deployed, which is
 * the entire subject of covan#172 (three published shapes their own API
 * rejects), so it is read defensively rather than trusted: a number, not
 * smaller than the page, and only when every row came back from the toolkit we
 * asked about. Failing that, the only honest total is the one a short page
 * proves — fewer rows than the limit, and no cursor, means the list is all of
 * them. Anything else and the caller renders no number at all.
 */
export async function listToolkitTools(
  env: ComposioEnv,
  query: { toolkit: string; limit?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ tools: ComposioTool[]; total: number | null; more: boolean }>> {
  const limit = Math.min(Math.max(query.limit ?? 10, 1), MAX_TOOLS_PAGE);
  const params = new URLSearchParams({
    toolkit_slug: query.toolkit.toUpperCase(),
    limit: String(limit),
  });

  const res = await request(
    env,
    `${CATALOGUE_API}/tools?${params}`,
    { method: "GET", maxBytes: MAX_CATALOGUE_BYTES },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  // Same reason as `searchTools`, and the consequence here is worse in one way:
  // `routes/composio.ts` renders `null` honestly for an error but an empty list as
  // "this application has no operations", so an unreadable page would tell somebody
  // deciding whether to connect an application that there is nothing to connect.
  if (body === null) {
    return {
      kind: "error",
      status: 502,
      message:
        `Composio's answer could not be read (${res.body.length} characters, ` +
        `${res.body.length >= MAX_CATALOGUE_BYTES ? "cut at the read cap" : "not JSON"})`,
    };
  }
  const returned = rows(body);
  const wanted = query.toolkit.toLowerCase();
  const tools = returned
    .map(toTool)
    .filter((t): t is ComposioTool => t !== null && t.toolkit === wanted);

  const more = Boolean(nextCursorOf(body));
  // Whether the filter was honoured at all. If anything foreign came back,
  // `toolkit_slug` was ignored — and then every count in the body is a count of
  // the whole catalogue, so neither road to a total may be taken.
  const filtered = tools.length === returned.length;
  // Counted off what Composio returned, not off what survived the filter —
  // otherwise dropping a foreign row would fake a short page and invent a total.
  const proven = !more && returned.length < limit ? tools.length : null;
  const total = filtered ? (publishedTotal(body, tools.length) ?? proven) : null;
  return { kind: "ok", tools, total, more };
}

/** One operation, with the full argument schema `searchTools` leaves out. */
export async function getTool(
  env: ComposioEnv,
  slug: string,
  opts?: ComposioOptions,
): Promise<ComposioResult<{ tool: ComposioTool }>> {
  const res = await request(
    env,
    `${CATALOGUE_API}/tools/${encodeURIComponent(slug)}`,
    { method: "GET" },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  const row = isRecord(body) ? (isRecord(body.data) ? body.data : body) : null;
  const tool = row ? toTool(row) : null;
  if (!tool) return { kind: "error", status: 502, message: `Composio described no tool ${slug}` };
  return { kind: "ok", tool };
}

/**
 * The hosts a toolkit logo may be fetched from.
 *
 * `meta.logo` is a string in somebody else's database, which makes it an
 * address a third party chooses and we resolve — the shape `lib/routines/
 * url-guard.ts` exists for. The guard here is narrower and cheaper than an
 * SSRF check because it can be: Composio serves every mark it publishes from
 * one of these two, so an allowlist answers the question completely and an
 * address anywhere else is refused rather than investigated.
 *
 * This is what keeps `GET /composio/logo` from being an open proxy. Widening
 * it is not a configuration change; it is a decision about what our own
 * servers will fetch on an anonymous caller's behalf.
 */
const LOGO_HOSTS = new Set(["logos.composio.dev", "assets.composio.dev"]);

/**
 * The logo address if we are willing to fetch it, `null` otherwise.
 *
 * HTTPS only, host on the list above, and nothing else about the URL is
 * trusted — a path, a query and a port are all the far end's business.
 */
export function allowedLogoUrl(raw: string): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!LOGO_HOSTS.has(url.hostname)) return null;
  return url;
}

/**
 * Category ids off a toolkit row.
 *
 * Composio has published these as `[{id,name}]` and as bare strings, and both
 * are in circulation — `toolkitOf`'s situation one field over. The id is what
 * the `category` filter takes, so the name is only a fallback for a row that
 * carried no id at all.
 */
function categoryIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id =
      typeof entry === "string" ? entry : isRecord(entry) ? text(entry.id) || text(entry.name) : "";
    if (id) out.push(id.toLowerCase());
  }
  return out;
}

/**
 * The total the catalogue claims, if it claims one this page does not contradict.
 *
 * Every condition here is a way the number could be wrong rather than absent,
 * and absent is the outcome we can render honestly. A total below the rows
 * already in hand is not a total of anything; a non-integer is a field that
 * means something else. `DESIGN.md` forbids a number the code cannot back, so
 * the bar is "this survives being checked", not "the key was present".
 */
function publishedTotal(value: unknown, atLeast: number): number | null {
  if (!isRecord(value)) return null;
  for (const key of ["total_items", "totalItems", "total"]) {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < atLeast) continue;
    return raw;
  }
  return null;
}

/** The page token, when the answer says there is more. */
function nextCursorOf(value: unknown): string {
  if (!isRecord(value)) return "";
  return text(value.next_cursor) || text(value.nextCursor);
}

/**
 * The applications a person can connect, for the catalogue screen.
 *
 * Ordered by usage when nobody has typed anything, which is the whole reason
 * the page can open on something useful: the first forty of fifteen hundred
 * applications in catalogue order is forty applications nobody has heard of.
 * A search brings its own relevance and we do not fight it.
 */
export async function listToolkits(
  env: ComposioEnv,
  query: { search?: string; category?: string; cursor?: string; limit?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ toolkits: ComposioToolkit[]; nextCursor: string }>> {
  const search = query.search?.trim();
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(query.limit ?? 40, 1), 100)),
  });
  if (search) params.set("search", search);
  else params.set("sort_by", "usage");
  if (query.category?.trim()) params.set("category", query.category.trim());
  if (query.cursor?.trim()) params.set("cursor", query.cursor.trim());

  const res = await request(env, `${CATALOGUE_API}/toolkits?${params}`, { method: "GET" }, opts);
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  const toolkits = rows(body)
    .map(toToolkit)
    .filter((t): t is ComposioToolkit => t !== null);
  return { kind: "ok", toolkits, nextCursor: nextCursorOf(body) };
}

/**
 * Composio's name for the stage at which a field is asked for. One is asked of
 * whoever sets the application up here; the other of whoever connects it. The
 * whole classification turns on which side of that line the required fields
 * fall, so both spellings are named once and read nowhere else.
 */
const CREATION = "auth_config_creation";
const INITIATION = "connected_account_initiation";

/**
 * Preferred order when an application publishes more than one way to supply a
 * credential.
 *
 * Datadog publishes three — OAuth, a bearer personal-access token, and an API
 * key — and the one chosen here becomes a durable auth config at Composio, so
 * taking whichever came first in their array would make a lasting decision
 * depend on their ordering staying stable. An API key leads because it is what
 * most providers document for this purpose; anything not named falls back to
 * the published order.
 */
const CREDENTIAL_MODES = ["API_KEY", "BEARER_TOKEN", "BASIC"];

/**
 * The authentication modes a toolkit publishes, or null when this row does not
 * carry them at all.
 *
 * Only the detail endpoint publishes these. An empty array is a different
 * thing from an absent one and is left as empty: the row spoke and said there
 * is nothing, which lands on `needs_setup` — refusing, which is the safe side.
 */
function authConfigDetailsOf(row: Record<string, unknown>): Record<string, unknown>[] | null {
  const raw = row.auth_config_details ?? row.authConfigDetails;
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRecord);
}

/**
 * How many fields a mode requires at one stage, or null when the row does not
 * say.
 *
 * This distinction is the most error-prone line in the classification, so it
 * is the only thing this function does. "Nothing is required" and "we were not
 * told what is required" are both falsy and mean opposite things — the first
 * is an application anyone can connect, the second is one we know nothing
 * about. Callers compare against `0` and `1` and never test truthiness, and an
 * absent parent object reads as unknown and so refuses.
 *
 * A missing `required` **beside a present parent** counts as empty, because a
 * JSON emitter dropping an empty array is a real thing. Composio's own API
 * emits them as of 2026-10-05, but that is a fact about today.
 */
function requiredCount(mode: Record<string, unknown>, stage: string): number | null {
  const fields = isRecord(mode.fields) ? mode.fields : null;
  if (!fields) return null;
  const at = fields[stage];
  if (!isRecord(at)) return null;
  const required = at.required;
  if (required === undefined || required === null) return 0;
  return Array.isArray(required) ? required.length : null;
}

/**
 * Whether this mode asks nothing of whoever set Covan up and something of
 * whoever is connecting — which is precisely what "the user supplies the
 * credential" means, said in the catalogue's own terms rather than by listing
 * the scheme names we happen to know about.
 *
 * The second half is load-bearing and easy to leave out. Without it every one
 * of the ninety-five `DCR_OAUTH` toolkits qualifies, because they require
 * nothing at either stage, and each would be sent to a hosted page with no
 * field on it. With it, they fall through to `needs_setup` on their own
 * merits. The same clause is what keeps `lever` and `brex` out, whose API-key
 * modes do require a field of their operator.
 */
function userSupplies(mode: Record<string, unknown>): boolean {
  const initiation = requiredCount(mode, INITIATION);
  return requiredCount(mode, CREATION) === 0 && initiation !== null && initiation >= 1;
}

/** The mode a credential connect would use, or null when there is none. */
function credentialModeOf(modes: Record<string, unknown>[]): Record<string, unknown> | null {
  const candidates = modes.filter(userSupplies);
  if (candidates.length === 0) return null;
  for (const preferred of CREDENTIAL_MODES) {
    const found = candidates.find((m) => text(m.mode).toUpperCase() === preferred);
    if (found) return found;
  }
  return candidates[0];
}

/**
 * A page where somebody can get the credential, if it is somewhere a browser
 * should be sent.
 *
 * `https` and nothing else. Deliberately not `allowedLogoUrl`'s host
 * allowlist: that list exists because we *fetch* the logo, and this address is
 * only ever handed to the browser as a link — restricting it to hosts we
 * happen to know would throw away the fourteen hundred providers whose own
 * documentation is the whole point of the link. What is excluded is the thing
 * that matters: a `javascript:` or `data:` address reaching an anchor tag.
 */
function allowedHintUrl(raw: string): string {
  if (!raw) return "";
  try {
    return new URL(raw).protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

/**
 * What connecting this application requires, as far as this row can say, plus
 * the two things the answer carries with it.
 *
 * The order of the questions is load-bearing twice. **No sign-in** is asked
 * first because such a toolkit has no credential to discuss at all. **Managed
 * OAuth** is asked before a supplied credential because a good few
 * applications publish both — Linear has Composio's own OAuth client *and* an
 * API-key mode — and a consent screen is the better of the two to offer a
 * person, since nothing has to be found first.
 *
 * Then, and only for a row that published its modes, the data-driven question:
 * is there a mode that asks nothing of an operator and something of the user?
 * Everything else is `needs_setup`, which is now said to a hundred and
 * fifty-nine applications rather than to fourteen hundred.
 */
function connectKindOf(
  row: Record<string, unknown>,
  modes: Record<string, unknown>[] | null,
): { kind: ComposioConnectKind | null; scheme: string; hintUrl: string } {
  const none = { scheme: "", hintUrl: "" };
  const managed = row.composio_managed_auth_schemes;
  const managedAuth = Array.isArray(managed) && managed.length > 0;

  // Two spellings of one fact, and each path carries only one of them. The
  // list row has a `no_auth` column; the detail row has no such column and
  // publishes a `NO_AUTH` mode instead. Reading only the column is why all
  // thirty-five of these used to fail at the connect route.
  //
  // **NO_AUTH only counts when it is the toolkit's whole story**, and that
  // clause is not tidiness. `gemini` publishes `NO_AUTH` *and* an `API_KEY`
  // mode asking the user for `generic_api_key`. While Connect was broken for
  // this kind the ambiguity cost nothing; once it works, calling gemini
  // no-auth means it connects successfully and then fails on every operation
  // that needs the key — at execute time, inside an agent turn, on a card that
  // says "connected", for a step of eight and a billed Composio call. And it
  // cannot heal: a missing credential is not `Tool_ToolNotFound`, so nothing
  // withdraws the slug. That is covan#258's defect, introduced on purpose.
  //
  // Narrowed here rather than by reordering the questions below, because the
  // order is load-bearing for its own reasons and moving it would trade this
  // bug for a different one. So: thirty-four applications, not thirty-five.
  const declaresNoAuth =
    row.no_auth === true || (modes ?? []).some((m) => text(m.mode).toUpperCase() === "NO_AUTH");
  const alsoNeedsSomething = managedAuth || (modes !== null && credentialModeOf(modes) !== null);
  if (declaresNoAuth && !alsoNeedsSomething) return { kind: "no_auth", ...none };

  if (managedAuth) return { kind: "managed_oauth", ...none };

  // A list row. It has already told us everything it can and the answer is not
  // in it; saying `needs_setup` here would be inventing one.
  if (modes === null) return { kind: null, ...none };

  const credential = credentialModeOf(modes);
  if (!credential) return { kind: "needs_setup", ...none };
  return {
    kind: "user_credential",
    scheme: text(credential.mode).toUpperCase(),
    hintUrl: allowedHintUrl(text(credential.auth_hint_url) || text(credential.authHintUrl)),
  };
}

function toToolkit(row: Record<string, unknown>): ComposioToolkit | null {
  const slug = text(row.slug);
  if (!slug) return null;
  const modes = authConfigDetailsOf(row);
  // The list endpoint publishes `auth_schemes` and the detail endpoint does
  // not, publishing the same names as the `mode` of each entry instead. Taken
  // from one place only, a toolkit read on the connect path would lose the
  // field it had in the grid — and the tile's hint is built from it.
  const schemes = row.auth_schemes ?? row.authSchemes ?? (modes ?? []).map((m) => m.mode);
  const managed = row.composio_managed_auth_schemes;
  const connect = connectKindOf(row, modes);
  // The description lives under `meta`, not at the top level. Read from the
  // wrong place it is silently the empty string and the card renders a row
  // with nothing under the name. The logo and the categories are in there
  // with it, and were being dropped for the same reason the description
  // nearly was.
  const meta = isRecord(row.meta) ? row.meta : {};
  const logo = allowedLogoUrl(text(meta.logo) || text(row.logo));
  return {
    slug: slug.toLowerCase(),
    name: text(row.name) || slug,
    description: text(meta.description) || text(row.description),
    authSchemes: Array.isArray(schemes)
      ? schemes.filter((s): s is string => typeof s === "string")
      : [],
    managedAuth: Array.isArray(managed) && managed.length > 0,
    noAuth: row.no_auth === true,
    connectKind: connect.kind,
    credentialScheme: connect.scheme,
    authHintUrl: connect.hintUrl,
    logo: logo ? logo.toString() : "",
    categories: categoryIdsOf(meta.categories ?? row.categories),
  };
}

/**
 * What a connect attempt should ask Composio to build, or null when it should
 * not ask at all.
 *
 * Reads `connectKind` and `credentialScheme` and nothing else. That is not an
 * implementation detail to tidy up later — it is the reason the page and the
 * worker cannot disagree. The card renders its sentence from those two fields;
 * if this function consulted a third, there would be a row somewhere whose
 * button promises one thing and whose connect builds another.
 *
 * Null now means two different things, and the caller has to tell them apart
 * before it gets here. For `needs_setup`, or for a row that could not say, null
 * means *refuse* — in the same words the card used. For **no sign-in** it means
 * *there is nothing to build*: ask `connectsWithoutAccount` first, because an
 * application that needs no credential needs no config, no account and no link,
 * and reading this function's null as a refusal would 502 all thirty-four of
 * them. That is covan#253, and the two questions are deliberately separate
 * functions so that one cannot be mistaken for the other.
 */
export function authConfigPlanFor(toolkit: ComposioToolkit): AuthConfigPlan | null {
  switch (toolkit.connectKind) {
    case "managed_oauth":
      return { kind: "managed_oauth" };
    case "user_credential":
      // A scheme is what the credential branch is *for*; without one there is
      // no body to post. Unreachable as `connectKindOf` is written, and
      // refusing rather than guessing is still the right shape, because the
      // guess would be a durable auth config of the wrong kind.
      return toolkit.credentialScheme
        ? { kind: "user_credential", scheme: toolkit.credentialScheme }
        : null;
    default:
      return null;
  }
}

/**
 * Whether this application is connected by writing a row and nothing else.
 *
 * Thirty-four of them are. A `NO_AUTH` toolkit has no credential, so Composio
 * has nothing to hold on its behalf: it refuses to make an auth config for one
 * (*"it does not require authentication… use its tools directly without
 * creating a connected account"*) and refuses a link without a config, and its
 * operations execute on `user_id` alone — verified against the live API
 * 2026-10-05. So connecting one means inserting a `composio_no_auth` row and
 * making no request at all. 0072 is what lets such a row exist.
 *
 * A separate function from `authConfigPlanFor` rather than a fourth plan kind,
 * and it reads the same single field, so the identity that guarantee rests on
 * is intact: both the card's sentence and the worker's route are decided by
 * `connectKind` and nothing else. What it buys is that "nothing to build" and
 * "refuse" stop sharing a return value.
 */
export function connectsWithoutAccount(toolkit: ComposioToolkit): boolean {
  return toolkit.connectKind === "no_auth";
}

/**
 * One application, by slug.
 *
 * Read at connect time, and it answers two questions the caller must not be
 * trusted for. **Whether it needs a sign-in at all** decides which kind of
 * auth config gets made, and taking that from the browser would mean a
 * request could pick. **Where its mark lives** is written onto the connection
 * row, so a connected application keeps its logo without the page having to
 * find it again in a catalogue of fifteen hundred — and so the logo is the
 * one the catalogue published rather than an address this code guessed from
 * the slug.
 *
 * One extra request, on the rarest action in the product. `authConfigFor`
 * makes the same trade one function down and for the same reason.
 */
export async function getToolkit(
  env: ComposioEnv,
  slug: string,
  opts?: ComposioOptions,
): Promise<ComposioResult<{ toolkit: ComposioToolkit }>> {
  const res = await request(
    env,
    `${CATALOGUE_API}/toolkits/${encodeURIComponent(slug)}`,
    { method: "GET" },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  const row = isRecord(body) ? (isRecord(body.data) ? body.data : body) : null;
  const toolkit = row ? toToolkit(row) : null;
  if (!toolkit) {
    return { kind: "error", status: 502, message: `Composio describes no application ${slug}` };
  }
  return { kind: "ok", toolkit };
}

/**
 * The catalogue's own headings, for the filter above the grid.
 *
 * Read rather than hard-coded: a list of categories written here is a list
 * that goes stale silently, and the ids are what the `category` filter takes —
 * so a guess that is one character out filters everything away rather than
 * failing.
 */
export async function listToolkitCategories(
  env: ComposioEnv,
  opts?: ComposioOptions,
): Promise<ComposioResult<{ categories: ComposioCategory[] }>> {
  const res = await request(env, `${CATALOGUE_API}/toolkits/categories`, { method: "GET" }, opts);
  if (res.kind === "error") return res;

  const seen = new Set<string>();
  const categories: ComposioCategory[] = [];
  for (const row of rows(parsed(res.body))) {
    const id = text(row.id) || text(row.slug);
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    categories.push({ id: id.toLowerCase(), name: text(row.name) || id });
  }
  return { kind: "ok", categories };
}

/**
 * Run one operation, on behalf of one connected account.
 *
 * **Both identifiers are the caller's to supply and neither is ever the
 * model's.** `run_tool` resolves them from the connection row; the model gets
 * to choose the slug and the arguments and nothing else. That is the reason
 * this is not `http_request` with a Composio base URL, despite the obvious
 * reuse: `http_request`'s body is model-written, and a model-written account
 * reference is one hallucinated identifier away from another workspace's
 * mailbox.
 */
export async function executeTool(
  env: ComposioEnv,
  call: {
    slug: string;
    /**
     * Absent for an application that needs no credential, where there is no
     * account to name — thirty-four of them (covan#253). **Omitted from the
     * body rather than sent as null**: the live API answers `successful: true`
     * for `{user_id, arguments}` alone, and covan#172 was three published
     * request shapes their own API rejected, two of them for sending a key it
     * did not want. An explicit null to an endpoint that validates a
     * discriminated union is the same mistake with a different spelling.
     */
    connectedAccountId?: string;
    userId: string;
    arguments: Record<string, unknown>;
  },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ body: string }>> {
  const res = await request(
    env,
    `${CORE_API}/tools/execute/${encodeURIComponent(call.slug)}`,
    {
      method: "POST",
      body: {
        ...(call.connectedAccountId ? { connected_account_id: call.connectedAccountId } : {}),
        user_id: call.userId,
        arguments: call.arguments,
      },
    },
    opts,
  );
  if (res.kind === "error") return res;

  /**
   * A 200 that says it failed.
   *
   * Composio answers HTTP 200 for a call the far end refused and puts the
   * refusal in the body as `successful: false` — so the transport succeeded
   * and the operation did not. Taking the status at face value recorded those
   * steps as `ok` in `message_steps`, which is a transcript that says an agent
   * did something it did not do. Measured on one turn: two of its eight steps
   * were Google 400s ("Following fields are missing: {'calendarId'}", "The
   * requested ordering is not available for the particular query") and both
   * were written down as successes.
   *
   * Reported as 200, which is what it was. `wasBilled` reads this number and
   * excludes only 501 and 502 — the two failures that never left the building
   * — and this one did leave: the far end was reached and Composio charges for
   * the attempt. Inventing a 4xx here would quietly stop counting calls that
   * cost money.
   */
  const body = parsed(res.body) as { successful?: unknown; error?: unknown } | null;
  if (body && typeof body === "object" && body.successful === false) {
    const why = typeof body.error === "string" && body.error.trim() ? body.error : res.body;
    return { kind: "error", status: 200, message: why };
  }
  return res;
}

/**
 * Whether a listed auth config was made by Covan's own side of this, or by
 * hand in Composio's dashboard. Null when the row says neither way.
 *
 * Two fields answer it and both are published: `is_composio_managed`, and
 * `type`, which reads `"custom"`. Either will do, and reading both means a
 * project whose list omits one still gets a right answer.
 */
function customConfig(row: Record<string, unknown>): boolean | null {
  if (row.is_composio_managed === false) return true;
  if (row.is_composio_managed === true) return false;
  const type = text(row.type).toLowerCase();
  if (type === "custom") return true;
  if (type) return false;
  return null;
}

/**
 * Whether an auth config Composio already has is the one this connect needs.
 *
 * It used to be "same toolkit, not disabled, first one wins", which was right
 * while there was only one kind of config a toolkit could have. There are two
 * now — Linear has Composio's own OAuth client *and* an API-key mode, and both
 * are legitimate in one project — so matching on the slug alone would hand an
 * API-key request somebody else's consent screen, or worse and permanently,
 * hand a *managed* request the API-key config and quietly break the
 * dashboard escape hatch this file documents two functions down.
 *
 * Two asymmetries, each deliberate. There used to be a third, a loose "any
 * enabled config will do" for an application needing no sign-in, justified by
 * such a toolkit having exactly one possible kind of config. That premise was
 * false — `gemini` publishes a credential mode too — and the case is gone
 * anyway: an application that needs no credential has no auth config to match
 * against and never reaches this function (covan#253).
 *
 * **Managed refuses only an explicit custom.** Absent is no information, and
 * no information has to mean today's behaviour or every project that omits the
 * field starts making duplicates.
 *
 * **A credential needs a positive match**, by scheme or by the name we write.
 * The name is the fallback because `auth_scheme` is documented optional on
 * list rows: without it, a project whose list omits the scheme would create a
 * fresh config on every connect forever — unbounded, where today the ceiling
 * is one per toolkit.
 */
function reusableConfig(row: Record<string, unknown>, slug: string, plan: AuthConfigPlan): boolean {
  const rowToolkit = isRecord(row.toolkit) ? text(row.toolkit.slug) : text(row.toolkit);
  if (rowToolkit.toLowerCase() !== slug) return false;
  // `is_disabled` is not on this shape — the live list carries
  // `status: "ENABLED" | "DISABLED"` — so reading only it meant a disabled
  // config was reusable, because `undefined !== true`. Both are read: the
  // field is real on connected accounts, so it is absent here rather than
  // imaginary, and it may yet appear.
  if (row.is_disabled === true) return false;
  if (text(row.status).toUpperCase() === "DISABLED") return false;

  const custom = customConfig(row);
  switch (plan.kind) {
    case "managed_oauth":
      return custom !== true;
    case "user_credential":
      return (
        custom !== false &&
        (text(row.auth_scheme).toUpperCase() === plan.scheme.toUpperCase() ||
          text(row.name) === configName(plan.scheme))
      );
  }
}

/**
 * The name written on a config Covan creates for a supplied credential.
 *
 * Deterministic on purpose: it is the fallback key `reusableConfig` matches on
 * when Composio's list row omits the scheme, so it has to be derivable from
 * the plan alone rather than carry a timestamp or an id.
 */
function configName(scheme: string): string {
  return `covan:${scheme.toUpperCase()}`;
}

/**
 * The `auth_config` object to post for one plan.
 *
 * The managed body is byte-identical to what this file has always sent, and
 * deliberately gains no field: covan#172 was three published request shapes
 * their own API rejected, and the hundred and twenty-three applications that
 * connect today must be provably untouched by this.
 *
 * **`authScheme` is camelCase.** The rest of Composio's API is snake_case and
 * the response to this very request echoes `auth_scheme`, but the request key
 * is camelCase and sending `auth_scheme` is a 400 —
 * *"Error in payload.auth_config.authScheme: Required"*. Found by trying it.
 *
 * `credentials: {}` is the load-bearing emptiness: it says the credential
 * arrives from whoever connects, at Composio, rather than from here.
 */
function createBodyFor(plan: AuthConfigPlan): Record<string, unknown> {
  switch (plan.kind) {
    case "managed_oauth":
      return { type: "use_composio_managed_auth" };
    case "user_credential":
      return {
        type: "use_custom_auth",
        authScheme: plan.scheme,
        credentials: {},
        name: configName(plan.scheme),
      };
  }
}

/**
 * What Composio says it made, when that is not what was asked for.
 *
 * The create response carries `auth_scheme` and `is_composio_managed` as
 * required fields, so this is nearly free. Absence is read as no information
 * rather than as a mismatch — the check exists to catch a wrong answer, not to
 * demand a complete one.
 */
function echoMismatch(echo: Record<string, unknown>, plan: AuthConfigPlan): string {
  const managed = echo.is_composio_managed;
  if (plan.kind === "managed_oauth") {
    return managed === false ? "a config with no OAuth application of its own" : "";
  }
  if (plan.kind === "user_credential") {
    if (managed === true) return "an OAuth config rather than a credential one";
    const scheme = text(echo.auth_scheme);
    if (scheme && scheme.toUpperCase() !== plan.scheme.toUpperCase()) {
      return `a ${scheme} config where ${plan.scheme} was asked for`;
    }
  }
  return "";
}

/**
 * The auth config a toolkit's consent flows hang off, made if there is not one.
 *
 * Composio's model has a layer the first draft of this file did not: an **auth
 * config** is the OAuth application for one provider, and a connected account
 * is somebody's grant against it. Nothing can be connected until one exists.
 *
 * It is created on demand rather than asked of the operator, and that is the
 * difference between this feature working and not. The alternative is somebody
 * opening Composio's dashboard and registering an application by hand for each
 * of fifteen hundred providers before anyone here can press Connect — which is
 * the per-service release this whole design exists to avoid, moved into
 * somebody else's console.
 *
 * `use_composio_managed_auth` is what makes that possible: Composio supplies
 * the OAuth client. The cost is the one `docs/integrations.md` names — the
 * consent screen carries their brand — and a workspace that minds can register
 * its own client in Composio's dashboard, which this will then find and use
 * instead of making a second.
 *
 * **`use_custom_auth` with empty credentials is the other half**, and it is the
 * larger one: for an application whose credential the person connecting
 * supplies, Composio hosts the page that collects it. Covan asks for a config
 * with no credentials in it and never sees what gets typed — which is the
 * whole reason this shape was chosen over a form of our own. Probed
 * 2026-10-05: the hosted page renders every required field with the
 * catalogue's own description, and submitting redirects to our callback like
 * any consent screen.
 *
 * **Nothing in Covan ever deletes an auth config.** `revoke.ts` revokes
 * connected accounts; configs accumulate monotonically, one per toolkit per
 * plan. That is deliberate — deleting one would orphan every other
 * workspace's accounts bound to it, and one Composio project serves every
 * workspace here.
 *
 * Not cached. It is one extra request on the rarest action in the product, and
 * a cache would be a second place for "which application is this" to be wrong.
 */
async function authConfigFor(
  env: ComposioEnv,
  toolkit: string,
  plan: AuthConfigPlan,
  opts?: ComposioOptions,
): Promise<{ kind: "ok"; id: string } | ComposioError> {
  const slug = toolkit.toLowerCase();
  const listed = await request(
    env,
    `${CORE_API}/auth_configs?toolkit_slug=${encodeURIComponent(slug.toUpperCase())}&limit=20`,
    { method: "GET" },
    opts,
  );
  if (listed.kind === "error") return listed;

  // Filtered again here rather than trusting the query parameter. An API that
  // ignores a filter it does not know returns EVERYTHING, and the first row of
  // everything is an OAuth application for some other provider entirely.
  //
  // Residual, a comment rather than code: this asks for twenty rows and
  // follows no cursor, so a project with more than twenty configs for one
  // toolkit could page past ours and make a duplicate. Twenty is already far
  // more than the two kinds that can legitimately exist.
  const existing = rows(parsed(listed.body)).find((row) => reusableConfig(row, slug, plan));
  if (existing && text(existing.id)) return { kind: "ok", id: text(existing.id) };

  const made = await request(
    env,
    `${CORE_API}/auth_configs`,
    {
      method: "POST",
      body: {
        toolkit: { slug: slug.toUpperCase() },
        auth_config: createBodyFor(plan),
      },
    },
    opts,
  );
  if (made.kind === "error") {
    // Each branch fails for its own reason and the raw message is about a
    // config type nobody outside this file has heard of, so each gets its own
    // sentence. Only the managed one is a job somebody can go and do.
    return {
      kind: "error",
      status: made.status,
      message:
        plan.kind === "user_credential"
          ? `Composio would not set up a credential-based sign-in for ${slug}. ` +
            `(${made.message})`
          : `Composio has no ready-made sign-in for ${slug}. Somebody needs to add an OAuth ` +
            `application for it in Composio's dashboard before it can be connected here. ` +
            `(${made.message})`,
    };
  }

  const body = parsed(made.body);
  const inner = isRecord(body) && isRecord(body.auth_config) ? body.auth_config : body;
  const id = isRecord(inner) ? text(inner.id) : "";
  if (!id) {
    return { kind: "error", status: 502, message: `Composio made no sign-in config for ${slug}` };
  }
  const wrong = isRecord(inner) ? echoMismatch(inner, plan) : "";
  if (wrong) {
    // A config of the wrong kind is durable and silent: connections get bound
    // to it, and the only symptom is a person being asked for the wrong thing
    // months later. Cheaper to refuse the one connect.
    return { kind: "error", status: 502, message: `Composio made ${wrong} for ${slug}` };
  }
  return { kind: "ok", id };
}

/**
 * Start a consent flow, and get back the address to send somebody to.
 *
 * Composio hosts the flow, so there is no `oauth-state.ts` here and no public
 * callback: Covan learns the outcome by asking about the account it just
 * created. That is a deliberate difference from `routes/connections.ts`, where
 * we hold the OAuth client and therefore have to hold the state too.
 */
export async function createLink(
  env: ComposioEnv,
  link: { toolkit: string; userId: string; plan: AuthConfigPlan; callbackUrl?: string },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ redirectUrl: string; connectedAccountId: string }>> {
  // A link is made against an AUTH CONFIG, not against a toolkit — which is
  // the one thing a reading of the documentation got wrong and a single probe
  // settled: `{"toolkit":…}` comes back 400 `payload.auth_config_id: Required`.
  // Still true on v3.1, checked 2026-10-05.
  const config = await authConfigFor(env, link.toolkit, link.plan, opts);
  if (config.kind === "error") return config;

  const res = await request(
    env,
    `${CORE_API}/connected_accounts/link`,
    {
      method: "POST",
      body: {
        auth_config_id: config.id,
        user_id: link.userId,
        ...(link.callbackUrl ? { callback_url: link.callbackUrl } : {}),
      },
    },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  const row = isRecord(body) ? (isRecord(body.data) ? body.data : body) : null;
  const redirectUrl = row ? text(row.redirect_url) || text(row.redirectUrl) || text(row.url) : "";
  const connectedAccountId = row ? text(row.id) || text(row.connected_account_id) : "";

  /**
   * A page is part of every flow that gets this far, and an empty address is
   * therefore a failure rather than a case to allow.
   *
   * This used to carry an exception for the one kind that legitimately comes
   * back with nowhere to go. It no longer needs one: an application that needs
   * no sign-in has no auth config and no link, so it never reaches this
   * function — the type of `link.plan` now says so (covan#253).
   *
   * Keep the warning, because it is the whole reason the exception was written
   * narrowly rather than as "not managed" or "has no scheme". Either of those
   * would accept a credential link with no page as success, and the result is
   * silent: the route inserts a pending row, answers `{url: ""}`, and the
   * browser's `if (url) window.location.assign(url)` does nothing whatever. The
   * button un-disables, a ghost row appears above the grid, the application
   * vanishes from the catalogue because it now counts as connected, and no
   * error fires so there is no toast. Every test still passes.
   */
  if (!connectedAccountId || !redirectUrl) {
    return {
      kind: "error",
      status: 502,
      message:
        link.plan.kind === "user_credential" && connectedAccountId
          ? `Composio made an account for ${link.toolkit} but no page to enter the ` +
            `credential on.`
          : "Composio started no consent flow we could follow",
    };
  }
  return { kind: "ok", redirectUrl, connectedAccountId };
}

/** How a consent flow ended, in `tool_connections.status`'s own vocabulary. */
export async function getConnectedAccount(
  env: ComposioEnv,
  id: string,
  opts?: ComposioOptions,
): Promise<ComposioResult<{ status: ConnectedAccountStatus }>> {
  const res = await request(
    env,
    `${CORE_API}/connected_accounts/${encodeURIComponent(id)}`,
    { method: "GET" },
    opts,
  );
  if (res.kind === "error") return res;

  const body = parsed(res.body);
  const row = isRecord(body) ? (isRecord(body.data) ? body.data : body) : null;
  return { kind: "ok", status: statusOf(row ? text(row.status) : "") };
}

/**
 * Composio's word for where a grant got to, in ours.
 *
 * Anything unrecognised is `pending` rather than `failed`, which is the
 * forgiving direction on purpose: a new status name should leave somebody's
 * half-finished connection polling, not mark a live grant broken.
 */
export function statusOf(raw: string): ConnectedAccountStatus {
  const value = raw.trim().toUpperCase();
  if (value === "ACTIVE" || value === "CONNECTED") return "active";
  if (value === "FAILED" || value === "EXPIRED" || value === "INACTIVE") return "failed";
  // `INITIALIZING` is what a freshly made link actually reports, confirmed
  // against the API. Named rather than left to the fallback below, so the one
  // status this product sees most often is not arrived at by accident.
  return "pending";
}

/**
 * Give the grant back.
 *
 * Called before the row is deleted, never after: a deleted row with a live
 * grant is an OAuth token at a third party that nobody in this product can see
 * or revoke, which is a GDPR-shaped hole rather than untidiness.
 */
export async function deleteConnectedAccount(
  env: ComposioEnv,
  id: string,
  opts?: ComposioOptions,
): Promise<ComposioResult<{ body: string }>> {
  return request(
    env,
    `${CORE_API}/connected_accounts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    opts,
  );
}
