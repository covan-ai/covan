import type { SupabaseClient } from "@supabase/supabase-js";
import type { TokenUser } from "./lib/jwt";
import type { Entitlements } from "./lib/entitlements";
// Type-only for the same reason: `lib/subrequests.ts` imports `RoutineEnv` back.
import type { SubrequestMeter } from "./lib/subrequests";
import type { RuntimeLimitFlag } from "./lib/runtime-limit";

/**
 * Exactly what the routine engine needs to run a tick.
 *
 * This exists because the engine is deployed twice. `src/index.ts` is the API
 * Worker and gets the full `Bindings` below; `src/cron.ts` is a scheduled-only
 * Worker on a separate Cloudflare account (see wrangler.cron.toml) that is
 * given these bindings and nothing else — no anon key, no R2 bucket. Typing the
 * engine against `Bindings` would have it claim bindings that Worker genuinely
 * does not have, and the first `env.DOCS` added to the engine would fail in
 * production rather than in tsc.
 *
 * ALLOWED_ORIGIN is here despite the cron Worker serving no HTTP: the SSRF
 * guard uses it to refuse routines pointed back at our own frontend.
 */
export type RoutineEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  /**
   * Where completions go. Unset means api.openai.com; set it to any
   * OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, OpenRouter) to keep the
   * conversation on infrastructure you control. Transcription is not routed
   * through it, and embeddings have a variable of their own — see `lib/openai`
   * for why they are two decisions rather than one.
   */
  OPENAI_BASE_URL?: string;
  /**
   * Forces one model for every completion, ignoring the per-agent picker.
   * Needed with OPENAI_BASE_URL because `lib/models` allowlists OpenAI's
   * catalogue, and a local endpoint serves names that are not in it.
   *
   * It does not reach a Claude pick, which is not served over that endpoint at
   * all — see `resolveModel`. That is only reachable when the key below is set,
   * so a deployment that has deliberately moved every completion in-house never
   * lands there.
   */
  OPENAI_MODEL?: string;
  /**
   * Anthropic's key, and the switch that makes the Claude models exist.
   *
   * Optional, and its absence is a supported configuration rather than a
   * misconfiguration: Covan needs exactly one provider to answer anything and
   * OPENAI_API_KEY above is it. Unset means the Claude ids are not offered in
   * the picker, not accepted by `PATCH /workspace`, and never resolved — so
   * nothing this deployment sends can reach Anthropic. Setting it is the act
   * that opts in. On Cloudflare: `wrangler secret put ANTHROPIC_API_KEY`.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * Where Claude completions go. Unset means api.anthropic.com. The Anthropic
   * half of OPENAI_BASE_URL, for a gateway or proxy in front of it; the two are
   * separate variables because they are separate endpoints, not two spellings
   * of one decision.
   */
  ANTHROPIC_BASE_URL?: string;
  /**
   * Composio's API key, and the switch that makes the catalogue exist.
   *
   * On `RoutineEnv` rather than `Bindings` because a scheduled routine may call a connected service, and the cron Worker has
   * no request to carry a key in on. It is a DEPLOYMENT secret — one Composio
   * project serves every workspace on this deployment — which is why
   * `tool_connections.connected_account_id` is withheld from every client role
   * (0063): on this arrangement that id is the only thing separating two
   * tenants.
   *
   * Optional, and its absence is a supported configuration rather than a
   * misconfiguration: unset means `find_tool` and `run_tool` are not offered to
   * any model, `POST /composio/connect` answers 501, and the Integrations page
   * names the variable rather than hiding the feature. Structurally the same
   * decision as `NOTION_CLIENT_ID`. On Cloudflare:
   * `wrangler secret put COMPOSIO_API_KEY`.
   */
  COMPOSIO_API_KEY?: string;
  /**
   * Where Composio's API lives. Unset means backend.composio.dev. The sibling
   * of `OPENAI_BASE_URL`, for a proxy or a self-hosted Composio in front of it.
   */
  COMPOSIO_BASE_URL?: string;
  /**
   * The signing secret of this deployment's Composio webhook subscription —
   * what `POST /composio/events` verifies every delivery with
   * (`lib/composio/webhook.ts`). `worker/scripts/composio-webhook-subscribe.ts`
   * makes the subscription and prints it.
   *
   * On `RoutineEnv`, and set on BOTH Workers, because it is also the switch
   * that says this deployment can hear Composio's triggers at all: without it
   * nothing would ever be delivered, so the Composio events are not offered,
   * and the cron Worker — which makes the trigger instances — must agree
   * with the API Worker about that, or it would subscribe to events nobody
   * can receive. Optional; unset, routines simply cannot start on a Composio
   * trigger. On Cloudflare: `wrangler secret put COMPOSIO_WEBHOOK_SECRET`.
   */
  COMPOSIO_WEBHOOK_SECRET?: string;
  /**
   * The `verification_token` Notion sent to `POST /notion/events` when the
   * public integration's webhook subscription was created, and the key every
   * later delivery's `X-Notion-Signature` is checked with. Notion sends it
   * exactly once (or again on "Resend token"); the route logs it while this is
   * unset, so the operator can read it, paste it into Notion's Verify form,
   * and set it here. Unset, the Notion events are not offered and the route
   * accepts nothing but that one handshake. On both Workers, for
   * `COMPOSIO_WEBHOOK_SECRET`'s reason. On Cloudflare:
   * `wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN`.
   */
  NOTION_WEBHOOK_VERIFICATION_TOKEN?: string;
  /**
   * The domain Resend receives mail on for this deployment, like
   * `reply.example.com` — the MX record points there. With the secret below it
   * switches on inbound mail (`lib/inbound-email/`): a routine's report carries
   * a `Reply-To` that starts the routine again with the answer, and a routine
   * can be given an address of its own to be mailed at. Optional, and both
   * Workers need both: the cron Worker sends most reports and keeps the event
   * subscriptions in step, the API Worker receives the mail.
   */
  INBOUND_EMAIL_DOMAIN?: string;
  /**
   * The signing secret of the Resend webhook that delivers `email.received` to
   * `POST /email/inbound` — Svix's format, `whsec_…`. On Cloudflare:
   * `wrangler secret put RESEND_INBOUND_WEBHOOK_SECRET`, on both Workers.
   */
  RESEND_INBOUND_WEBHOOK_SECRET?: string;
  /**
   * browser-use's API key, and the switch that makes the `browse` tool exist.
   *
   * On `RoutineEnv` rather than `Bindings` for `COMPOSIO_API_KEY`'s reason,
   * and more sharply: the cron Worker is the thing that POLLS a browser task,
   * so a key set only on the API Worker creates tasks nothing ever finishes.
   * It is a DEPLOYMENT secret — Covan pays for the browser, the person asking
   * never does — which is the whole economic shape of the feature.
   *
   * Optional, and its absence is a supported configuration: unset means
   * `browse` is offered to no model and the Integrations page names the
   * variable. On Cloudflare: `wrangler secret put BROWSER_USE_API_KEY`, on
   * BOTH Workers.
   */
  BROWSER_USE_API_KEY?: string;
  /** A proxy, or a self-hosted browser-use, in front of api.browser-use.com. Their framework is MIT. */
  BROWSER_USE_BASE_URL?: string;
  /** The same, for the v4 runs API (`lib/browser/v4.ts`). `BROWSER_USE_BASE_URL` keeps applying to v2 only. */
  BROWSER_USE_V4_BASE_URL?: string;
  /**
   * The model a `browse` run asks browser-use for, over `DEFAULT_MODEL` in
   * `lib/browser/v4.ts`. Empty means unset, as for the two URLs above; a name
   * outside the provider's list is a 422 on every run.
   */
  BROWSER_USE_MODEL?: string;
  /**
   * How hard a `browse` run's model reasons: `none` … `max`, or `provider` to
   * send nothing and take browser-use's default (`xhigh` for `gpt-5.6-luna`).
   * Empty means `DEFAULT_REASONING` in `lib/browser/v4.ts`.
   */
  BROWSER_USE_REASONING?: string;
  /** base64 32-byte AES-GCM key for delivery_channels.secret_ciphertext. */
  ROUTINE_SECRET_KEY: string;
  /**
   * How many events may start one routine in an hour, and in a day, before it
   * is paused and its owner told (0109). Whole numbers; unset or nonsense
   * means 60 and 500 — see `lib/routines/events/receive.ts` for why these are
   * a fuse rather than a budget.
   */
  ROUTINE_EVENT_RUNS_PER_HOUR?: string;
  ROUTINE_EVENT_RUNS_PER_DAY?: string;
  RESEND_API_KEY: string;
  /** Verified sender, e.g. "Routines <routines@yourdomain.com>". */
  RESEND_FROM: string;
  ALLOWED_ORIGIN: string;
  /** This worker's own domain, once a custom domain fronts it (unset on workers.dev). */
  WORKER_HOST?: string;
  /**
   * `"1"` on the hosted build, which charges workspaces credits. Unset on every
   * self-hosted deployment, which charges nobody: the operator brings their own
   * provider keys and decides what to spend on them.
   *
   * The value enables nothing by itself — metering is enabled by an entry point
   * that registers an implementation (see `lib/entitlements`). Declared here, in
   * the shared type, because shared code checks for its presence to catch a
   * hosted deploy that forgot to register one.
   */
  CREDITS_ENABLED?: string;
  /**
   * Which Cloudflare plan this deployment runs on, which decides how much one
   * invocation is allowed to spend. See `lib/limits.ts` for what moves with it.
   *
   * Unset means `"free"` — the convention every optional var here follows, and
   * the safe direction: a Paid deployment that forgets this runs conservatively
   * and finishes fewer turns, where a Free deployment that had to opt *out*
   * would instead fail at a platform ceiling that reports itself as a dropped
   * connection. Only `"paid"` is read; anything else is Free.
   */
  WORKER_PLAN?: "free" | "paid";
  /**
   * How many subrequests this REQUEST has spent so far.
   *
   * Not configuration, unlike everything else here, and it is on this type for
   * the reason `lib/subrequests.ts` gives: `env` is the one thing every client
   * factory already receives, and threading a parameter instead would mean
   * touching thirty-nine places that build a service-role client, to carry
   * something none of them care about.
   *
   * Always absent on the bindings themselves. It is added to an OVERLAY, per
   * request — the bindings object is
   * shared between the requests an isolate serves and must never be written to.
   */
  SUBREQUESTS?: SubrequestMeter;
};

/**
 * What it takes to write a document: embed its text and put its bytes
 * somewhere.
 *
 * Split out of `SyncEnv` because there are now two things that write documents
 * and only one of them is a connection. A routine that files its summary needs
 * exactly this and none of the OAuth credentials below — and a Worker holding
 * this and no credentials is a perfectly good deployment that files routine
 * output and offers no connected sources.
 */
export type DocumentEnv = RoutineEnv & {
  /**
   * Where document embeddings go. Unset means api.openai.com, which is also
   * what `OPENAI_BASE_URL` on its own leaves them at — the two do not inherit
   * from each other, deliberately (`lib/openai`).
   */
  EMBEDDING_BASE_URL?: string;
  /** Unset means `text-embedding-3-small`. Set it whenever the endpoint is. */
  EMBEDDING_MODEL?: string;
  /**
   * The width of `document_chunks.embedding`. Unset means 1536, which is what
   * migration 0004 declares. Changing this without changing the column — or the
   * other way round — is caught at the first embedding call rather than at the
   * insert; see `lib/embeddings`.
   */
  EMBEDDING_DIMENSIONS?: string;
  /** The R2 bucket, on Cloudflare only. Absent on the Node/Docker runtime. */
  DOCS?: R2Bucket;
  /** Filesystem document root, on the Node runtime only. Absent on Cloudflare. */
  DOCS_DIR?: string;
};

/**
 * What the connection engine needs, which is strictly more than the routine
 * engine and strictly less than the API.
 *
 * A sync writes documents: it embeds text and puts bytes in the document store,
 * so it needs the embedding configuration and one of the two storage bindings —
 * neither of which the routine engine has ever touched. Naming that as its own
 * type is what lets `cron.ts` stay honest: it is deployed with `RoutineEnv` and
 * may or may not have been given the rest, so it asks rather than claiming them
 * in a type and finding out in production.
 *
 * The storage binding is what `canSyncConnections` tests, but it is not the
 * whole of what a sync needs — the OAuth client credentials below are the other
 * half, and a Worker holding one without the other is the dangerous
 * combination rather than the harmless one. `lib/background` checks for both
 * before a tick claims anything, and the comment there says what goes wrong if
 * it does not.
 */
export type SyncEnv = DocumentEnv & {
  /**
   * OAuth client credentials, one pair per connectable source. Every one is
   * optional and absence is a supported configuration: a deployment that sets
   * none simply offers no connections, and the Integrations page says which
   * variables would turn each one on rather than hiding it.
   */
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

/**
 * Whether this environment can actually run a sync.
 *
 * The document store is the discriminator, for the same reason it is in
 * `getDocStore`: it is the one binding that has no default and no fallback. A
 * cron Worker deployed without it should say so once per tick and skip, not
 * fail every connection in the workspace and pause them all.
 */
export function canSyncConnections(env: RoutineEnv): env is SyncEnv {
  const candidate = env as SyncEnv;
  return Boolean(candidate.DOCS || candidate.DOCS_DIR);
}

/**
 * Whether this environment can write a document at all.
 *
 * The sibling of `canSyncConnections`, testing the same binding and answering a
 * different question — and the separation is the point rather than an
 * accident. A routine that files its output needs a document store and no
 * OAuth credentials; a connection sync needs both. Folding the two into one
 * predicate would mean a Worker with storage and no Notion credentials could
 * not file routine output either, for a reason that has nothing to do with it.
 *
 * WHY THIS EXISTS AT ALL, which is the part worth reading. The cron Worker is
 * deployed with `RoutineEnv` and, on Cloudflare, frequently has no R2 binding —
 * `wrangler.cron.toml.example` says so, because an R2 bucket cannot be shared
 * across accounts. Filing is the only optional thing a routine run does, and
 * `getDocStore` THROWS when nothing is bound. An unguarded call would land in
 * `runRoutine`'s catch, be recorded as a failure, back the schedule off
 * geometrically, and at `MAX_FAILURES` pause a routine that is delivering
 * perfectly — because of an extra nobody would have missed. The guard is what
 * turns that into one sentence in the run history.
 */
export function canFileDocuments(env: RoutineEnv): env is DocumentEnv {
  const candidate = env as DocumentEnv;
  return Boolean(candidate.DOCS || candidate.DOCS_DIR);
}

/**
 * Bindings + secrets available to the API Worker, across both runtimes it
 * ships on. Secrets (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * OPENAI_API_KEY, ROUTINE_SECRET_KEY) are set via `wrangler secret put` on
 * Cloudflare. ALLOWED_ORIGIN is a plain var. Document storage is either DOCS
 * (the R2 bucket binding, Cloudflare only) or DOCS_DIR (a filesystem root,
 * Node/Docker only) — see `getDocStore` in `lib/docstore`, the only place that
 * reads either. ADMIN_API_KEY (optional) gates the /admin/backfill-embeddings
 * maintenance endpoint; when unset the endpoint fails closed.
 */
export type Bindings = SyncEnv & {
  SUPABASE_ANON_KEY: string;
  /**
   * The cosine-similarity floor below which a retrieved chunk is dropped as
   * irrelevant. Unset means 0.25, which is tuned against
   * `text-embedding-3-small` — an operator who changes the embedding model
   * needs their own floor, because a wrong one does not break retrieval, it
   * quietly makes it worse.
   */
  RAG_MIN_SIMILARITY?: string;
  /**
   * Whether the lexical (keyword / `tsquery`) search arm runs alongside
   * vector search. Unset or blank means on — see `lexicalSearchEnabled`
   * in `lib/search-terms.ts` for the resolver and why an empty string
   * has to mean the same thing as unset.
   */
  RAG_LEXICAL?: string;
  /**
   * The project's JWT signing secret, and the one thing that makes API keys
   * possible: a key is exchanged for a short-lived JWT for its owner, so the
   * request reaches Postgres as that person and RLS decides as it always does.
   * See `lib/api-keys.ts`.
   *
   * Optional, and its absence is a supported configuration rather than a
   * misconfiguration — a deployment that never sets it simply has no API keys,
   * and says so instead of failing. On Cloudflare: `wrangler secret put
   * SUPABASE_JWT_SECRET`. On a self-hosted stack it is the same `JWT_SECRET` the
   * rest of the compose file already uses, which is why `lib/env.ts` accepts
   * either name.
   */
  SUPABASE_JWT_SECRET?: string;
  ADMIN_API_KEY?: string;
  /**
   * The Slack app this deployment owns. All three or none: a client pair with
   * no signing secret could install and then reject every event it was sent,
   * which is the configuration mistake that looks like a Slack outage.
   *
   * On `Bindings` rather than `SyncEnv` because Slack is a surface, not a
   * source — it is served by the API Worker and there is nothing for a cron
   * tick to do with it.
   */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  /**
   * Rate limiting, on Cloudflare only — `[[ratelimits]]` in wrangler.toml.
   * Their presence is what makes `getRateLimiter` use the edge counter instead
   * of the in-process one, the same way `DOCS` chooses R2 over the filesystem.
   * Absent on Node, where the two variables below configure the fallback.
   */
  RATE_LIMIT_STANDARD?: RateLimit;
  RATE_LIMIT_EXPENSIVE?: RateLimit;
  /**
   * The document engine's clock on Cloudflare: one `DocumentRoom` Durable
   * Object per job (`lib/docs/host.ts`). Optional — without it a job is
   * advanced by the open tab's poll and by the cron, which is slower and loses
   * nothing. Never present on Node, which drives jobs in-process.
   */
  DOC_ROOMS?: DurableObjectNamespace;
  /**
   * Cloudflare Browser Rendering, for PDF export (`lib/formats/pdf.ts`).
   * Optional — without it the PDF button falls back to the browser's own
   * print-to-PDF. Never present on Node.
   */
  BROWSER?: Fetcher;
  /**
   * Requests per minute on the Node runtime. Unset takes the defaults in
   * `lib/ratelimit/types.ts`; `0` disables that tier, which is what an operator
   * who limits in nginx or Cloudflare in front of this should set rather than
   * running two limiters that disagree.
   */
  RATE_LIMIT_STANDARD_PER_MINUTE?: string;
  RATE_LIMIT_EXPENSIVE_PER_MINUTE?: string;
  /**
   * Where a chat turn runs on Cloudflare, so it outlives the tab that asked —
   * `[[durable_objects.bindings]]` in wrangler.toml, the `TurnRoom` class.
   * Absent on Node, which runs turns in-process, and on a Cloudflare deploy
   * that has not added it, where a turn still ends with its request. See
   * `lib/turns`.
   */
  TURN_ROOMS?: DurableObjectNamespace;
  /**
   * Where a routine started by a webhook or an app event runs on Cloudflare,
   * so it finishes after the sender has been answered: the `RoutineRoom`
   * class (`lib/routines/poke-room.ts`). Absent on Node, where the process
   * outlives the request, and on a Cloudflare deploy that has not added it,
   * where the run gets `waitUntil`'s thirty seconds.
   */
  ROUTINE_ROOMS?: DurableObjectNamespace;
  /**
   * The address of the socket this request arrived on. Node only: `node.ts`
   * sets it on every request, and its presence is how `clientAddress` knows it
   * is not on Cloudflare — where `CF-Connecting-IP` is the address and this is
   * never set.
   */
  PEER_ADDR?: string;
  /**
   * How many proxies in front of the Node API append to `X-Forwarded-For`.
   * Unset or `0`: none, and the socket address is the caller. See
   * `clientAddress` in `middleware/ratelimit.ts`.
   */
  TRUST_PROXY?: string;
  /**
   * Where a message from the quota wall goes. Defaults to `efe@covan.app`.
   *
   * A default rather than a required secret, so there is nothing to forget on
   * deploy. A self-hoster who has registered their own metered entitlements can
   * reach that form and should set this.
   */
  SUPPORT_EMAIL?: string;
};

/**
 * Per-request context set by middleware.
 * `db` is a request-scoped Supabase client carrying the caller's bearer token,
 * so Postgres RLS (`auth.uid()`) resolves to the authenticated user.
 */
export type Variables = {
  /**
   * Not Supabase's `User`. Routes read `id` and `email` from this and nothing
   * else, and a session token carries both — which is what lets
   * `middleware/auth.ts` establish a caller without asking GoTrue for the rest
   * of a record nobody reads. Narrow on purpose: if a route ever needs more,
   * the compiler says so here rather than the field arriving undefined.
   */
  user: TokenUser;
  db: SupabaseClient;
  /** What this caller may spend. Unmetered unless a hosted build says otherwise. */
  entitlements: Entitlements;
  /**
   * The workspace this request's spending is charged to. Set by `guardCredits`
   * and read by `recordCredits`, so the two cannot disagree.
   */
  workspaceId?: string;
  /**
   * Set only when the caller proved themselves with an API key rather than a
   * browser session. Routes read it to refuse the things a key must not do —
   * chiefly creating another key, which would make revocation meaningless.
   */
  apiKeyId?: string;
  /**
   * The workspace the key was made in, set beside `apiKeyId`. A key acts there
   * and nowhere else: `callerWorkspaceId` answers with it instead of the
   * owner's active workspace, and the token minted for the request carries it
   * as `covan_ws`, which the workspace helpers in Postgres check (0087).
   */
  apiKeyWorkspaceId?: string;
  /**
   * Raised when anything in this request discovers the invocation is out of
   * platform budget, so a route can say so instead of "an error".
   *
   * On the context rather than made per turn because the counter below shares
   * it and starts counting in the auth middleware, before any route runs. See
   * `lib/runtime-limit.ts` for why one shared flag beats an error that
   * propagates — by the time anything propagates, the real message is gone.
   */
  runtimeLimit: RuntimeLimitFlag;
  /**
   * What this request has spent of its platform budget.
   *
   * Set by the auth middleware, which is where the caller's own Supabase client
   * is built and therefore the first thing that can spend one. See
   * `lib/subrequests.ts`.
   */
  subrequests: SubrequestMeter;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
