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
   * False means somebody has to register a client with that provider and paste
   * it into Composio before anybody here can connect — a real job, not a
   * retry. Surfaced so the card can say so, rather than offering a Connect
   * button whose only outcome is a 400 from a third party.
   */
  managedAuth: boolean;
  /**
   * Whether the provider needs no sign-in at all.
   *
   * The second of the two ways an application can be connected as it stands,
   * and for a while the forgotten one: `docs/integrations.md` has counted these
   * thirty-five into "158 connect as they are" since the feature shipped, while
   * the field was never read — so the page called every one of them "Needs
   * setup in Composio" and refused to connect it. Read here, and the connect
   * route builds a `no_auth` config for it instead of an OAuth one.
   */
  noAuth: boolean;
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

function toToolkit(row: Record<string, unknown>): ComposioToolkit | null {
  const slug = text(row.slug);
  if (!slug) return null;
  const schemes = row.auth_schemes ?? row.authSchemes;
  const managed = row.composio_managed_auth_schemes;
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
    logo: logo ? logo.toString() : "",
    categories: categoryIdsOf(meta.categories ?? row.categories),
  };
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
    connectedAccountId: string;
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
        connected_account_id: call.connectedAccountId,
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
 * Not cached. It is one extra request on the rarest action in the product, and
 * a cache would be a second place for "which application is this" to be wrong.
 */
async function authConfigFor(
  env: ComposioEnv,
  toolkit: string,
  noAuth: boolean,
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
  const existing = rows(parsed(listed.body)).find((row) => {
    const rowToolkit = isRecord(row.toolkit) ? text(row.toolkit.slug) : text(row.toolkit);
    return rowToolkit.toLowerCase() === slug && row.is_disabled !== true;
  });
  if (existing && text(existing.id)) return { kind: "ok", id: text(existing.id) };

  const made = await request(
    env,
    `${CORE_API}/auth_configs`,
    {
      method: "POST",
      body: {
        toolkit: { slug: slug.toUpperCase() },
        // An application that asks for no credentials still needs a config to
        // hang a connection off; what it does not need is an OAuth client.
        // Asking for a managed one here is what Composio answers 400 to, and
        // for a long time that 400 was the whole reason these thirty-five
        // looked unconnectable.
        auth_config: { type: noAuth ? "no_auth" : "use_composio_managed_auth" },
      },
    },
    opts,
  );
  if (made.kind === "error") {
    // The likely cause is a provider Composio has no OAuth application for, and
    // that is a job rather than a retry: somebody has to register a client with
    // the provider and paste it into Composio. Said in those words, because the
    // raw message is about a config type nobody outside this file has heard of.
    return {
      kind: "error",
      status: made.status,
      message: noAuth
        ? `Composio would not open ${slug} without a sign-in after all. (${made.message})`
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
  link: { toolkit: string; userId: string; callbackUrl?: string; noAuth?: boolean },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ redirectUrl: string; connectedAccountId: string }>> {
  // A link is made against an AUTH CONFIG, not against a toolkit — which is
  // the one thing a reading of the documentation got wrong and a single probe
  // settled: `{"toolkit":…}` comes back 400 `payload.auth_config_id: Required`.
  const config = await authConfigFor(env, link.toolkit, link.noAuth === true, opts);
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
  // The account is the part that must exist. The consent screen is not: an
  // application that needs no sign-in has nowhere to send anybody, and comes
  // back with an account and an empty address. The caller reads an empty
  // `redirectUrl` as "there is nothing to go and do" rather than as a failure.
  if (!connectedAccountId || (!redirectUrl && link.noAuth !== true)) {
    return {
      kind: "error",
      status: 502,
      message: "Composio started no consent flow we could follow",
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
