import { parseCost, send, type BrowserEnv, type BrowserResult } from "./client";

/**
 * The provider's v4 runs API.
 *
 * Beside `client.ts` rather than inside it, because `client.ts` is v2 — tasks,
 * their status, stopping them — and is kept, byte for byte, until nothing
 * reads it. This file is what replaces it: one run per `browse` call, polled
 * through a status endpoint that answers one word, read once for its summary
 * after it ends, and followed through an event log. Same header, same `send`,
 * a different base.
 *
 * **Every request here is sent with `redactBody: true`.** Each one names a
 * provider id — a run, a session, a profile — and `send`'s reasoning for
 * withholding the provider's error text applies to all of them: it ends up in
 * `message_steps.result_excerpt`, readable by every member of a shared session.
 *
 * **`runEvents` is the file's one structural rule, and it is `profiles.ts`'s
 * for `cdpUrl`.** A `browser.ready` event carries `live_view_url` and
 * `cdp_url`; the second is full control of a browser holding somebody's
 * sessions and the first is a credential too (the provider says so outright).
 * So the event type this file returns has a place for `browser_session_id` and
 * nowhere for a URL, and a field no function copies cannot reach a log line, a
 * row or a message. The live URL is fetched on demand, for its caller only, by
 * `browserLiveUrl` in `profiles.ts`.
 */

/** The v4 base. Overridable by `BROWSER_USE_V4_BASE_URL`; see `v4BaseOf`. */
export const V4_BASE = "https://api.browser-use.com/api/v4";

/**
 * The model a run asks for when the caller names none.
 *
 * Sent explicitly rather than left to the provider's default (`gpt-6-luna`,
 * today), because the default is theirs to move and this is a cost line:
 * $0.24 in / $1.44 out per million tokens.
 */
export const DEFAULT_MODEL = "gpt-5.6-luna";

/** The reasoning levels a run may ask for; each model family spells them its own way. */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The reasoning a run asks for when the operator names none.
 *
 * **Sent, because leaving it out is not neutral.** A request that names a
 * model and no `modelParams` gets the provider's reasoning default for that
 * model, and for `gpt-5.6-luna` that is `xhigh` — the most expensive level
 * short of `max`, on every step of a run that takes dozens, billed at the
 * output rate. Medium rather than low because a run that reasons too little
 * fails, and a failed run is paid for and then retried.
 */
export const DEFAULT_REASONING: ReasoningEffort = "medium";

/**
 * `modelParams` for one model at one effort, in that model's family's shape —
 * or undefined, and the provider's default stands.
 *
 * The provider validates `modelParams` per model, so a shape sent to the wrong
 * family is a 422 on every run. Undefined, therefore, for a family this does
 * not know (`grok-*`, `glm-*`, `kimi-*`, `minimax-*` take none at all) and
 * for a level the family has no word for: Claude has no `none`, Gemini no
 * `xhigh` or `max`.
 */
export function modelParamsFor(
  model: string,
  effort: ReasoningEffort,
): Record<string, unknown> | undefined {
  if (model.startsWith("gpt-")) {
    // The two GPTs whose list is shorter: astra has no `none`, 5.5 no `max`.
    if (effort === "none" && model.startsWith("gpt-6-astra")) return undefined;
    if (effort === "max" && model === "gpt-5.5") return undefined;
    return { reasoning: { effort } };
  }
  if (model.startsWith("claude-") && effort !== "none") return { output_config: { effort } };
  if (model.startsWith("gemini-")) {
    const level = effort === "none" ? "minimal" : effort;
    return level === "xhigh" || level === "max"
      ? undefined
      : { thinkingConfig: { thinkingLevel: level } };
  }
  return undefined;
}

/**
 * `BROWSER_USE_REASONING` as an effort. Empty or unset is `DEFAULT_REASONING`;
 * `provider` is null, and no `modelParams` is sent. A word outside the list is
 * the default too, rather than a 422 on every run.
 */
export function reasoningOf(raw: string | undefined): ReasoningEffort | null {
  const word = raw?.trim().toLowerCase();
  if (word === "provider") return null;
  return REASONING_EFFORTS.find((effort) => effort === word) ?? DEFAULT_REASONING;
}

/**
 * The ceiling on the one free retry after a person hands the browser back
 * (`handBackBrowser`), which nobody is charged for — the one run that still
 * carries a `maxCostUsd`.
 *
 * A paid run carried one too until 2026-10-24, at $0.25: a run asked to look
 * through several sites reached it, ended with no answer, and the person got
 * an error for a quarter they had already spent. A paid run now runs until it
 * finishes and is charged what it cost (`settle.ts`). The free retry keeps a
 * ceiling because the operator pays it: of the first four, three ran to the
 * full $0.25 and ended with no answer, against a typical task's two to six
 * cents. It starts in a browser that is already signed in and on the page, so
 * it has less to do than the run it continues.
 */
export const RETRY_COST_CAP_USD = 0.1;

/**
 * Their six words. `dispatching` is the one v2 never had: accepted, not yet on
 * a worker. Anything else the provider might say is read as `running`; see
 * `toRunStatus`.
 */
export type RunStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";

export type CreatedRun = { id: string; sessionId: string; status: RunStatus };

export type RunSummary = {
  id: string;
  status: RunStatus;
  /** The agent's prose answer, or null. */
  result: string | null;
  /** The provider's structured output when an `outputSchema` was sent; null otherwise. Not interpreted here. */
  output: unknown;
  error: string | null;
  /** Dollars, parsed from the provider's string; null if unparseable. */
  totalCostUsd: number | null;
  sessionId: string;
};

/**
 * One entry of a run's event log.
 *
 * `data` is whatever the provider put there, minus every live or CDP URL — see
 * `scrubEvent`. For a `browser.attached`, `browser.ready` or
 * `browser.reattached` event it is `{ browser_session_id }` and nothing else.
 *
 * **The catalogue (Task 3.4).** The provider publishes none; these are the
 * `type` values eight real runs sent on 2026-10-11, in the order a run sends
 * them, with the fields of `data` each carried. `live.ts`'s `eventLine` turns
 * them into the panel's lines.
 *
 * - `run.created` — `model`, `session_id`, `workspace_id`, `is_free_tier`,
 *   `browser_settings` (`profile_id`, `proxy_country_code`, `custom_proxy` as
 *   a boolean, …) and `secret_bindings` as `{ alias, allowed_domains }` only:
 *   no value.
 * - `run.dispatching` (`transport`), `run.dispatched` (`transport`,
 *   `browser_session_id`), `worker.started`, `workspace.ready`, `core.spawn`.
 * - `browser.attached` — `browser_session_id`, `live_view_url`,
 *   `cdp_url_present`; then `browser.ready` (`browser_session_id`,
 *   `live_view_url`) on a new browser, or `browser.reattached` (the same) on a
 *   follow-up in the conversation's browser.
 * - `llm.request` / `llm.response` — one pair per model call: model, token
 *   counts, `cost_usd`.
 * - `core.event` — the provider agent's own transcript, `data.type` one of
 *   `step_start`, `reasoning` (encrypted), `tool_use`, `step_finish`, `text`,
 *   with the detail in `data.part`. A `tool_use` names `part.tool`:
 *   `browser_execute` (its `state.input.description` is the agent's own
 *   sentence for the step; `state.input.code` and `state.output` are the code
 *   and the page), `skill`, or `bash` — which is how it types a saved login,
 *   `POST …/secrets/<alias>/type`, answering `{ alias, code, ok, origin }` and
 *   never the value. A `text` part is what the agent says, its last one the
 *   run's JSON answer.
 * - `secret.typed` — `secret: { alias, origin }`, once per field typed.
 * - `outputs.promoted`, `state.promoted`, `run.completed`, `browser.released`
 *   (`status`: `kept_alive`, `timeout_at`, `browser_session_id`),
 *   `worker.session_released`.
 *
 * Only the three browser events carried a live URL, and no event carried a
 * `wss://` address or a secret's value.
 */
export type RunEvent = { id: number; ts: string; type: string; data: Record<string, unknown> };

export type RunEvents = { events: RunEvent[]; nextAfter: number | null; hasMore: boolean };

export type CustomProxy = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  ignoreCertErrors?: boolean;
};

/** A credential this run may have typed into a field on `allowedDomains`, never shown to the agent. */
export type SecretBinding = {
  alias: string;
  source: { type: "inline"; value: string };
  allowedDomains: string[];
};

export type CreateRunInput = {
  task: string;
  /** The provider's session id from an earlier run: a follow-up in the same browser. Omit for a first run. */
  sessionId?: string;
  /**
   * `null` is sent as `null` (ruling R38): on a follow-up it is the provider's
   * "not this profiled browser" — *"an explicit value mismatching the live
   * browser's profile (incl. null vs a profiled browser) declines reuse and
   * provisions fresh"*. `undefined` names none and the live browser is reused.
   */
  profileId?: string | null;
  /** `null` is the provider's "no proxy"; `undefined` leaves its default (US). */
  proxyCountryCode?: string | null;
  customProxy?: CustomProxy;
  secretBindings?: SecretBinding[];
  /** Sent when given. What an answer shaped like it means is the caller's to decide. */
  outputSchema?: Record<string, unknown>;
  model?: string;
  /** Sent when given, in the shape `modelParamsFor` builds for `model`. */
  modelParams?: Record<string, unknown>;
  /** The provider's ceiling on what the run may spend. Omitted, it has none. */
  maxCostUsd?: number;
};

/**
 * `||` rather than `??`, as `baseOf` in `client.ts`: an empty string is not an
 * override, and `docker-compose.yml` sets one when the operator has not.
 * `BROWSER_USE_BASE_URL` is deliberately not consulted — it is v2's, and a
 * self-hoster who set it for v2 would otherwise have v4 requests sent to a
 * server that has no `/runs`.
 */
export function v4BaseOf(env: BrowserEnv): string {
  return (env.BROWSER_USE_V4_BASE_URL || V4_BASE).replace(/\/+$/, "");
}

/**
 * `send` against the v4 base. Exported because `profiles.ts` shares it: all
 * nine of its `/profiles` and `/browsers` operations are identical between the
 * v2 and v4 documents, so it moved here rather than keep a second base.
 */
export function sendV4<T>(
  env: BrowserEnv,
  path: string,
  init: { method: string; body?: unknown; redactBody?: boolean },
  opts: { signal?: AbortSignal } | undefined,
  parse: (body: unknown) => T,
): Promise<BrowserResult<T>> {
  return send(env, path, init, { ...opts, base: v4BaseOf(env) }, parse);
}

export function isTerminalRun(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * **A status word we have not met is `running`**, which is non-terminal. This
 * is `client.ts`'s `mapStatus` reasoning again: it must mean "come back
 * later". Guessing `completed` would deliver an empty answer, and guessing
 * `failed` would throw away work already paid for. The cost of being wrong in
 * this direction is a poll that never settles, which the sweep bounds.
 */
function toRunStatus(raw: unknown): RunStatus {
  switch (String(raw)) {
    case "queued":
    case "dispatching":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return String(raw) as RunStatus;
    default:
      return "running";
  }
}

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function text(raw: unknown): string | null {
  return typeof raw === "string" && raw ? raw : null;
}

/**
 * Hand a run over. Answers as soon as the provider has accepted it, not when
 * the browser has finished.
 *
 * The provider rejects unknown keys on the body and on `browserSettings`
 * (`additionalProperties: false`), so this sends exactly the fields its schema
 * names and **omits an absent optional rather than sending `null`**. The two
 * `null`s that go out are the two that mean something: `proxyCountryCode:
 * null`, run without a proxy, and `profileId: null`, a browser without the
 * person's profile (ruling R38).
 */
export function createRun(
  env: BrowserEnv,
  input: CreateRunInput,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<CreatedRun>> {
  const proxy = input.customProxy;
  const browserSettings = {
    ...(input.profileId === null
      ? { profileId: null }
      : input.profileId
        ? { profileId: input.profileId }
        : {}),
    ...(input.proxyCountryCode === undefined ? {} : { proxyCountryCode: input.proxyCountryCode }),
    ...(proxy
      ? {
          customProxy: {
            host: proxy.host,
            port: proxy.port,
            ...(proxy.username ? { username: proxy.username } : {}),
            ...(proxy.password ? { password: proxy.password } : {}),
            ...(proxy.ignoreCertErrors === undefined
              ? {}
              : { ignoreCertErrors: proxy.ignoreCertErrors }),
          },
        }
      : {}),
  };
  return sendV4(
    env,
    "/runs",
    {
      method: "POST",
      body: {
        task: input.task,
        model: input.model ?? DEFAULT_MODEL,
        ...(input.modelParams ? { modelParams: input.modelParams } : {}),
        ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(Object.keys(browserSettings).length > 0 ? { browserSettings } : {}),
        ...(input.secretBindings?.length ? { secretBindings: input.secretBindings } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      },
      redactBody: true,
    },
    opts,
    (body) => {
      const row = record(body);
      return {
        id: String(row.id ?? ""),
        sessionId: String(row.sessionId ?? ""),
        status: toRunStatus(row.status),
      };
    },
  );
}

/** The cheap poll: one word, no task text, no result. */
export function runStatus(
  env: BrowserEnv,
  runId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<{ status: RunStatus }>> {
  return sendV4(
    env,
    `/runs/${encodeURIComponent(runId)}/status`,
    { method: "GET", redactBody: true },
    opts,
    (body) => ({ status: toRunStatus(record(body).status) }),
  );
}

function toRunSummary(body: unknown): RunSummary {
  const row = record(body);
  return {
    id: String(row.id ?? ""),
    status: toRunStatus(row.status),
    result: text(row.result),
    output: row.output ?? null,
    error: text(row.error),
    totalCostUsd: parseCost(row.totalCostUsd),
    sessionId: String(row.sessionId ?? ""),
  };
}

/** The whole run, read once after it is terminal. */
export function runSummary(
  env: BrowserEnv,
  runId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<RunSummary>> {
  return sendV4(
    env,
    `/runs/${encodeURIComponent(runId)}`,
    { method: "GET", redactBody: true },
    opts,
    toRunSummary,
  );
}

/** Keys that carry a live or CDP URL, wherever they sit in an event's data. */
const URL_KEYS = new Set(["live_view_url", "cdp_url", "liveUrl", "cdpUrl", "liveViewUrl"]);

/** The browser events: the ones that announce a browser and, today, carry its URLs. */
const BROWSER_EVENT_TYPES = new Set(["browser.attached", "browser.ready", "browser.reattached"]);

function withoutUrlKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUrlKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !URL_KEYS.has(key))
        .map(([key, inner]) => [key, withoutUrlKeys(inner)]),
    );
  }
  return value;
}

/**
 * **An allowlist for the three browser events, a denylist for the rest.**
 *
 * `browser.ready`/`browser.reattached` are the events documented to carry the
 * URLs, and real runs showed `browser.attached` carrying one too, so for them
 * nothing is copied except `browser_session_id`: a URL-valued field the
 * provider adds next month cannot get through a rule that names what IS kept. Other events are free-form text the poller shows as progress, and
 * allowlisting those would blank the feature; for them the known URL keys are
 * stripped at any depth, as a second belt rather than the first.
 */
function scrubEvent(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (BROWSER_EVENT_TYPES.has(type)) {
    return typeof data.browser_session_id === "string"
      ? { browser_session_id: data.browser_session_id }
      : {};
  }
  return withoutUrlKeys(data) as Record<string, unknown>;
}

/**
 * The run's event log from `after` (an event id; 0 is the start).
 *
 * `nextAfter` is the cursor to pass back, and null when the provider gave none
 * — the caller keeps the one it had.
 */
export function runEvents(
  env: BrowserEnv,
  runId: string,
  after: number,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<RunEvents>> {
  return sendV4(
    env,
    `/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
    { method: "GET", redactBody: true },
    opts,
    (body) => {
      const row = record(body);
      const events = Array.isArray(row.events) ? row.events : [];
      return {
        events: events.map((raw): RunEvent => {
          const event = record(raw);
          const type = String(event.type ?? "");
          return {
            id: Number(event.id ?? 0),
            ts: String(event.ts ?? ""),
            type,
            data: scrubEvent(type, record(event.data)),
          };
        }),
        nextAfter: typeof row.nextAfter === "number" ? row.nextAfter : null,
        hasMore: row.hasMore === true,
      };
    },
  );
}

/**
 * Stop a run. Idempotent at the provider: cancelling one that has already
 * ended answers its summary, with its real status, rather than an error — so
 * the caller reads `status` and does not assume `cancelled`.
 */
export function cancelRun(
  env: BrowserEnv,
  runId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<{ status: RunStatus }>> {
  return sendV4(
    env,
    `/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", redactBody: true },
    opts,
    (body) => ({ status: toRunStatus(record(body).status) }),
  );
}

/**
 * The browsers a provider session has used, as id and status and nothing else.
 *
 * The provider's list answers `liveUrl` and `cdpUrl` on every item; the type
 * returned has nowhere to put either. A session can use more than one browser
 * over time, so the caller picks the active one rather than the first.
 */
export function browsersFor(
  env: BrowserEnv,
  agentSessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<{ id: string; status: "active" | "stopped" }[]>> {
  return sendV4(
    env,
    `/browsers?agentSessionId=${encodeURIComponent(agentSessionId)}`,
    { method: "GET", redactBody: true },
    opts,
    (body) => {
      const items = record(body).items;
      return (Array.isArray(items) ? items : []).map((raw) => {
        const item = record(raw);
        return {
          id: String(item.id ?? ""),
          // `active` is the safe misreading, as in `profiles.ts`: a browser we
          // wrongly believe is stopped is one nobody ever stops.
          status: String(item.status) === "stopped" ? ("stopped" as const) : ("active" as const),
        };
      });
    },
  );
}
