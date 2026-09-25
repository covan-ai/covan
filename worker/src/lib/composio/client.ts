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
 * The deployment's Composio credentials.
 *
 * Narrow on purpose rather than `Bindings`: this module is reached from the
 * cron Worker as well as the API one, and a type that claimed the rest would be
 * claiming bindings that Worker does not have.
 */
export type ComposioEnv = {
  COMPOSIO_API_KEY?: string;
  COMPOSIO_BASE_URL?: string;
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
 * arguments and is null unless it was asked for — see `searchTools`, which
 * deliberately does not fetch it.
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
};

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
  init: { method: string; body?: unknown },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ body: string }>> {
  if (!env.COMPOSIO_API_KEY) {
    return { kind: "error", status: 501, message: "this deployment has no COMPOSIO_API_KEY set" };
  }
  const doFetch = opts?.fetchImpl ?? fetch;

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

  const body = await readBody(res);

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
async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text().catch(() => "")).slice(0, MAX_BYTES);
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return out.slice(0, MAX_BYTES);
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
 * `limit` is small by design and the caller's cap is smaller still: a result
 * that reaches the model truncated mid-JSON is worse than a short one, and
 * `loop.ts` slices blindly at eight thousand characters.
 */
export async function searchTools(
  env: ComposioEnv,
  query: { search: string; toolkit?: string; limit?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ tools: ComposioTool[] }>> {
  const params = new URLSearchParams({
    search: query.search,
    limit: String(Math.min(Math.max(query.limit ?? 10, 1), 50)),
  });
  if (query.toolkit) params.set("toolkit_slug", query.toolkit.toUpperCase());

  const res = await request(env, `${CATALOGUE_API}/tools?${params}`, { method: "GET" }, opts);
  if (res.kind === "error") return res;

  const tools = rows(parsed(res.body))
    .map(toTool)
    .filter((t): t is ComposioTool => t !== null);
  return { kind: "ok", tools };
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

/** The applications a person can connect, for the catalogue screen. */
export async function listToolkits(
  env: ComposioEnv,
  query: { search?: string; limit?: number },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ toolkits: ComposioToolkit[] }>> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(query.limit ?? 40, 1), 100)),
  });
  if (query.search?.trim()) params.set("search", query.search.trim());

  const res = await request(env, `${CATALOGUE_API}/toolkits?${params}`, { method: "GET" }, opts);
  if (res.kind === "error") return res;

  const toolkits = rows(parsed(res.body))
    .map((row): ComposioToolkit | null => {
      const slug = text(row.slug);
      if (!slug) return null;
      const schemes = row.auth_schemes ?? row.authSchemes;
      const managed = row.composio_managed_auth_schemes;
      // The description lives under `meta`, not at the top level. Read from
      // the wrong place it is silently the empty string and the card renders a
      // row with nothing under the name.
      const meta = isRecord(row.meta) ? row.meta : {};
      return {
        slug: slug.toLowerCase(),
        name: text(row.name) || slug,
        description: text(meta.description) || text(row.description),
        authSchemes: Array.isArray(schemes)
          ? schemes.filter((s): s is string => typeof s === "string")
          : [],
        managedAuth: Array.isArray(managed) && managed.length > 0,
      };
    })
    .filter((t): t is ComposioToolkit => t !== null);
  return { kind: "ok", toolkits };
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
        auth_config: { type: "use_composio_managed_auth" },
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
      message:
        `Composio has no ready-made sign-in for ${slug}. Somebody needs to add an OAuth ` +
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
  link: { toolkit: string; userId: string; callbackUrl?: string },
  opts?: ComposioOptions,
): Promise<ComposioResult<{ redirectUrl: string; connectedAccountId: string }>> {
  // A link is made against an AUTH CONFIG, not against a toolkit — which is
  // the one thing a reading of the documentation got wrong and a single probe
  // settled: `{"toolkit":…}` comes back 400 `payload.auth_config_id: Required`.
  const config = await authConfigFor(env, link.toolkit, opts);
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
  if (!redirectUrl || !connectedAccountId) {
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
