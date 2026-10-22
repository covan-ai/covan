import { Hono, type Context } from "hono";
import { callDeletionFn } from "../lib/deletion";
import { z } from "zod";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { callerWorkspaceId } from "../lib/workspace";
import { mapRoutine, mapRoutineRun, mapDeliveryChannel } from "../lib/dto";
import { parseDraft } from "../lib/routines/draft";
import { runOneRoutine, runPokedRoutine, runTestRoutine } from "../lib/routines/dispatcher";
import type { RoutineRow } from "../lib/routines/executor";
import { isValidCron, nextRunAt } from "../lib/routines/schedule";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { encryptSecret, decryptSecret } from "../lib/secret-box";
import { deliver, deliveryDepsFrom } from "../lib/routines/delivery";
import {
  CONFIRMABLE_COLUMNS,
  DAILY_LINKS_PER_OWNER,
  askToConfirm,
  linksSentToday,
  ownConfirmedAddress,
  readyForDelivery,
  sameAddress,
  type ConfirmableChannel,
  type ConfirmationOutcome,
} from "../lib/routines/address-confirmation";
import {
  generateSigningSecret,
  parseWebhookSecret,
  serialiseWebhookSecret,
  EVENT_TEST,
} from "../lib/routines/webhook";
import { getRateLimiter } from "../lib/ratelimit";
import { generateIngestToken } from "../lib/routines/ingest";
import { rateLimitKey } from "../middleware/ratelimit";
import { maskSecret } from "../lib/routines/crypto";
import { insertErrorStatus } from "../lib/routines/insert-error";
import { siteHostOf } from "../lib/browser/credentials";
import { createRoutine } from "../lib/routines/create";
import { MODEL_IDS, REASONING_EFFORTS, providerFor, resolveModel } from "../lib/models";
import { estimateCostUsd } from "../lib/pricing";
import {
  classifyProviderError,
  explainProviderFailure,
  isProviderError,
  reportProviderFailure,
} from "../lib/provider-error";
import { complete } from "../lib/completion";
import { deferred } from "../lib/defer";
import { guardCredits, recordCredits } from "../lib/entitlements/guard";
import { completionSpend, quoteOf, spends, type Spend } from "../lib/entitlements";
import { apiKeyIdOf, refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { parseEventChoice, triggerLabel, type EventChoice } from "../lib/routines/events/catalog";
import { EVENT_REGISTRY, canListenFor } from "../lib/routines/events/adapter";
import {
  releaseSubscription,
  replaceSubscription,
  subscriptionSetup,
  syncSubscription,
} from "../lib/routines/events/lifecycle";
import { checkRequirement, connectedInWorkspace } from "../lib/routines/events/requirements";
import { agentAddress, inboundDomain } from "../lib/inbound-email/address";
import { pairingCode } from "../lib/routines/events/telegram";

const routines = new Hono<AppEnv>();

// ---- draft ---------------------------------------------------------------

const draftBodySchema = z.object({
  text: z.string().min(1),
  timezone: z.string().default("UTC"),
});

// POST /routines/draft — natural language in, an editable definition out.
// Nothing is persisted; the user confirms on screen before anything is saved.
// This is the only place in this file that touches an LLM: setup reasons once,
// every execution afterwards is deterministic.
routines.post("/routines/draft", async (c) => {
  // No routine exists yet, so the caller's active workspace pays.
  const denied = await guardCredits(c);
  if (denied) return denied;

  const env = c.env;

  const parsed = draftBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // parseDraft may call the model more than once. Totalled here and recorded
  // once, whether the draft parses or is rejected — a failed parse still spent.
  const spent: Array<Spend | null> = [];
  // Drafting has no agent behind it, so there is no per-agent model to honour
  // — `null` takes the default, or OPENAI_MODEL when one is set.
  const model = resolveModel(null, env);
  const completeOne = async (prompt: string) => {
    const { text, usage } = await complete(env, {
      model,
      messages: [{ role: "user", content: prompt }],
      json: true,
    });
    spent.push(completionSpend(model, usage, "routine_draft"));
    return text;
  };

  try {
    const draft = await parseDraft(parsed.data.text, {
      complete: completeOne,
      timezone: parsed.data.timezone,
    });
    return c.json(draft);
  } catch (err) {
    // The model refusing is not the text being unreadable, and saying it was
    // sent people to an empty form to type by hand what the model would have
    // filled in a minute later — or, with the provider's account empty, never
    // (covan-ai/covan#350). The SDK's own words stay in the log: they name the
    // account, and are the operator's to read.
    if (isProviderError(err)) {
      console.error("routine draft: the model refused", err);
      const failure = classifyProviderError(err, providerFor(model));
      deferred(c, reportProviderFailure(env, failure));
      return c.json(
        {
          error: explainProviderFailure(failure),
          code: "model_unavailable",
          retryable: failure.retryable,
        },
        503,
      );
    }
    return c.json({ error: err instanceof Error ? err.message : "could not read that" }, 422);
  } finally {
    await recordCredits(c, spends(...spent));
  }
});

// ---- delivery channels -----------------------------------------------------

const channelSchema = z.object({
  kind: z.enum(["slack_webhook", "email", "webhook"]),
  secret: z.string().min(1),
});

/**
 * What the caller sends as `secret`, checked for the shape its kind requires.
 *
 * The Slack check is narrower than the generic one on purpose and stays that
 * way: `slack_webhook` formats its body as Slack expects and would produce
 * nonsense anywhere else, so accepting an arbitrary URL under that kind would
 * be accepting a channel that cannot work. `webhook` is the kind for
 * everywhere else, and it gets the same guard every outbound fetch in this
 * codebase gets — scheme, private address, our own hosts — and no vendor rule
 * at all, because naming vendors is the thing this feature exists not to do.
 */
function channelSecretProblem(
  kind: "slack_webhook" | "email" | "webhook",
  secret: string,
  ownHosts: string[],
): string | null {
  if (kind === "email") {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(secret) ? null : "not an email address";
  }
  try {
    const url = assertFetchableUrl(secret, ownHosts);
    if (kind === "slack_webhook" && url.host !== "hooks.slack.com") {
      return "not a slack webhook url";
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "invalid url";
  }
}

// GET /delivery-channels — masked labels only; RLS scopes to the caller and the
// column grant means the secret is not selectable even by mistake.
routines.get("/delivery-channels", async (c) => {
  // Without the ones a revoked key made: nothing can deliver to them or choose
  // them again, so offering one in a picker is offering a refusal.
  const { data, error } = await c
    .get("db")
    .from("delivery_channels")
    .select("id, kind, label, created_at, confirmed_at")
    .is("disabled_at", null)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load channels" }, 500);
  return c.json((data ?? []).map(mapDeliveryChannel));
});

/**
 * The create-time half of 0096 for an email address.
 *
 * The caller's own confirmed sign-in address is confirmed as it is created:
 * they have already proved that mailbox, and asking again is friction for
 * nothing. Any other address is created unconfirmed and mailed a link — but
 * only `DAILY_LINKS_PER_OWNER` of those a day, refused here before the row
 * exists, so the question cannot itself be a way to mail strangers.
 */
async function emailAddressStart(
  env: Parameters<typeof ownConfirmedAddress>[0],
  userId: string,
  address: string,
): Promise<{ confirmedAt: string | null } | { refused: string }> {
  if (sameAddress(address, await ownConfirmedAddress(env, userId))) {
    return { confirmedAt: new Date().toISOString() };
  }
  if ((await linksSentToday(serviceClient(env), userId)) >= DAILY_LINKS_PER_OWNER) {
    return {
      refused:
        `You have asked ${DAILY_LINKS_PER_OWNER} addresses to confirm today. ` +
        "Try again tomorrow, or use your own address.",
    };
  }
  return { confirmedAt: null };
}

/** Mail the link for a channel just created unconfirmed. */
async function askNewAddress(
  env: Parameters<typeof askToConfirm>[0],
  channel: { id: string; user_id: string },
  address: string,
): Promise<ConfirmationOutcome> {
  return askToConfirm(env, serviceClient(env), { ...channel, confirmation_sent_at: null }, address);
}

// POST /delivery-channels — the one write that needs the service role, because
// the secret must be encrypted before it is stored. The owner comes from the
// verified token, never from the body. The workspace is the caller's *active*
// workspace (profiles.active_workspace_id), not an arbitrary membership row —
// a user in several workspaces would otherwise get a channel filed under
// whichever workspace happened to sort first.
routines.post("/delivery-channels", async (c) => {
  const parsed = channelSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { kind, secret } = parsed.data;

  const problem = channelSecretProblem(kind, secret, ownHostsFrom(c.env));
  if (problem) return c.json({ error: problem }, 400);

  const user = c.get("user");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  let confirmedAt: string | null = null;
  if (kind === "email") {
    const start = await emailAddressStart(c.env, user.id, secret);
    if ("refused" in start) return c.json({ error: start.refused }, 429);
    confirmedAt = start.confirmedAt;
  }

  // A webhook channel's secret is the URL *and* a signing secret, as one JSON
  // object under the same envelope — see 0054 for why they share the column and
  // why the signing secret is minted per channel instead of derived from
  // ROUTINE_SECRET_KEY.
  const signingSecret = kind === "webhook" ? generateSigningSecret() : null;
  const plaintext = signingSecret ? serialiseWebhookSecret({ url: secret, signingSecret }) : secret;

  const { data, error } = await serviceClient(c.env)
    .from("delivery_channels")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      kind,
      label: maskSecret(kind, secret),
      secret_ciphertext: await encryptSecret(plaintext, c.env.ROUTINE_SECRET_KEY),
      api_key_id: apiKeyIdOf(c),
      confirmed_at: confirmedAt,
    })
    .select("id, user_id, kind, label, created_at, confirmed_at")
    .single();

  if (error) return c.json({ error: "failed to create channel" }, 500);

  // What happened to the question, so the form can say "check that inbox" or
  // why it could not be asked.
  const confirmation =
    kind === "email" && !confirmedAt ? await askNewAddress(c.env, data, secret) : undefined;

  // The only response that ever carries it. It is stored encrypted rather than
  // hashed because signing needs the secret back, but that is not a reason to
  // hand it out again on every list: a receiver is configured once, and a
  // secret that can be re-read is a secret that leaks through a screenshot of
  // the settings page. Lost it? Rotate.
  return c.json(
    {
      ...mapDeliveryChannel(data),
      ...(signingSecret ? { signingSecret } : {}),
      ...(confirmation ? { confirmation } : {}),
    },
    201,
  );
});

/**
 * A new signing secret for an existing webhook channel.
 *
 * The URL is carried over rather than re-sent by the caller: rotation is about
 * the secret, and letting the request name a destination would turn "give me a
 * new key" into "point this channel somewhere else" — past the guard that runs
 * on create, from a route nobody would think to read that way.
 *
 * Both halves of the row are rewritten together because they live in one
 * ciphertext. There is a window of exactly one statement in which the old
 * secret is still the live one; a receiver updated before this call verifies
 * nothing and a receiver updated after it verifies everything, which is what a
 * rotation is.
 */
routines.post("/delivery-channels/:id/rotate", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "rotate a webhook signing secret");
  if (refusal) return c.json(refusal, 403);

  const user = c.get("user");
  const id = c.req.param("id");

  const db = serviceClient(c.env);
  // Scoped to the caller by hand: the service role bypasses RLS, so `user_id`
  // here is doing the job `delivery_channels_select_own` does everywhere else.
  const { data: channel, error } = await db
    .from("delivery_channels")
    .select("kind, secret_ciphertext")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return c.json({ error: "invalid channel id" }, 400);
    return c.json({ error: "failed to load channel" }, 500);
  }
  if (!channel) return c.json({ error: "no such channel" }, 404);
  if (channel.kind !== "webhook") {
    return c.json({ error: "only a webhook channel has a signing secret" }, 400);
  }

  let url: string;
  try {
    const config = parseWebhookSecret(
      await decryptSecret(channel.secret_ciphertext, c.env.ROUTINE_SECRET_KEY),
    );
    url = config.url;
  } catch {
    return c.json({ error: "this channel's secret could not be read" }, 500);
  }

  const signingSecret = generateSigningSecret();
  const { error: updateError } = await db
    .from("delivery_channels")
    .update({
      secret_ciphertext: await encryptSecret(
        serialiseWebhookSecret({ url, signingSecret }),
        c.env.ROUTINE_SECRET_KEY,
      ),
    })
    .eq("id", id)
    .eq("user_id", user.id);

  if (updateError) return c.json({ error: "failed to rotate the signing secret" }, 500);
  return c.json({ signingSecret });
});

/**
 * Send one message through a channel, now, so somebody can see it arrive.
 *
 * Every kind, not only the new one. "Did my Slack URL paste correctly" has been
 * unanswerable since 0012 except by waiting for a routine to run, and the
 * answer for a webhook — is the signature what my receiver expects — is worth
 * even more, because getting it wrong is silent on both ends.
 *
 * NOT mounted behind `rateLimit("expensive")` in index.ts, deliberately. That
 * middleware's mount list is what `ratelimit.static.test.ts` compares against
 * the set of endpoints that buy a completion, and this endpoint buys none:
 * adding it there would break the ratchet's first claim and the honest fix
 * would be to weaken the ratchet. It takes the same limiter by hand instead,
 * which is the same bound without the false statement.
 */
routines.post("/delivery-channels/:id/test", async (c) => {
  const verdict = await getRateLimiter(c.env, "expensive").check(`channel-test:${rateLimitKey(c)}`);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  const user = c.get("user");
  const { data: row, error } = await serviceClient(c.env)
    .from("delivery_channels")
    .select(CONFIRMABLE_COLUMNS)
    .eq("id", c.req.param("id"))
    .eq("user_id", user.id)
    .is("disabled_at", null)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return c.json({ error: "invalid channel id" }, 400);
    return c.json({ error: "failed to load channel" }, 500);
  }
  if (!row) return c.json({ error: "no such channel" }, 404);

  // An address that has not confirmed gets the question again (within its
  // limits), not a test message: the test is exactly the mail it has not
  // agreed to. The answer says which happened.
  const channel = await readyForDelivery(c.env, row as ConfirmableChannel);
  if (channel.kind === "email" && !channel.confirmed_at) {
    return c.json({ error: "unconfirmed", confirmation: channel.asked ?? "unavailable" }, 409);
  }

  try {
    await deliver(
      channel,
      {
        subject: "Covan test delivery",
        body:
          "This is a test message from Covan, sent because somebody pressed " +
          "Send test on this delivery channel. No routine produced it.",
      },
      deliveryDepsFrom(c.env),
      // No routine block: there is no routine behind this, and saying so is
      // the point — a receiver that files results must be able to leave this
      // one out.
      { event: EVENT_TEST },
    );
  } catch (err) {
    // The receiver's own words. This endpoint exists to report them: a test
    // send that failed with "could not deliver" would be worth less than not
    // having the button.
    return c.json({ error: err instanceof Error ? err.message : "delivery failed" }, 502);
  }

  return c.body(null, 204);
});

routines.delete("/delivery-channels/:id", async (c) => {
  const { error } = await c
    .get("db")
    .from("delivery_channels")
    .delete()
    .eq("id", c.req.param("id"));

  if (error) {
    // 22P02 is Postgres's "invalid input syntax" — a malformed uuid in the
    // path, which is a bad request, not a conflict.
    if (error.code === "22P02") return c.json({ error: "invalid channel id" }, 400);
    // Otherwise this is routines.delivery_channel_id's FK: `no action deferrable
    // initially deferred` lets same-transaction cascades (workspace/user delete)
    // complete first, but a direct delete of a channel still wired to a routine
    // still fails the check when it's evaluated at end of statement/transaction —
    // surface that as a conflict.
    return c.json({ error: "channel is still in use" }, 409);
  }
  return c.body(null, 204);
});

// ---- routines --------------------------------------------------------------

/** What a person picked from the catalogue. The config is the entry's to check. */
const eventChoiceSchema = z.object({
  type: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Every read of a routine that answers a client embeds its subscription, so
 * the routine's page and list know what an event routine waits for without a
 * second request. The embed names only the columns 0109 grants, and
 * `routine_event_subscriptions_select_own` answers it for the owner alone —
 * a colleague reading a shared routine gets `event: null`.
 */
// It also embeds the channels after the primary (0130), by id:
// `routine_channels_select_visible` answers whoever can see the routine, and
// the channels themselves stay their owner's. One literal, because
// postgrest-js types the row from the string and cannot read a concatenation.
const ROUTINE_SELECT =
  "*, event:routine_event_subscriptions(provider, event_type, config, status, status_detail, last_event_at, expires_at), channels:routine_channels(delivery_channel_id)";

/**
 * The editor's Inbox switch, model and thinking (0123), for create and edit
 * alike. `model` is the allowlist `routes/agents.ts` uses; null hands the
 * choice back to the agent.
 */
const runChoices = {
  deliverInbox: z.boolean().optional(),
  model: z.enum(MODEL_IDS).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
};

const createSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().min(1),
    // `workspace` needs neither `sourceUrl` nor `connectionId` below — it reads
    // its own workspace, resolved server-side (see `createRoutine`'s
    // `sourceConfigFor`). Whether the caller may actually use it is
    // `routine_workspace_source_is_permitted` (0076), not this schema.
    sourceKind: z.enum(["rss", "web", "none", "connection", "workspace"]),
    sourceUrl: z.string().nullable().optional(),
    /** Required for `connection`, ignored otherwise. */
    connectionId: z.string().uuid().nullable().optional(),
    instruction: z.string().min(1),
    deliveryChannelId: z.string().uuid().optional(),
    /**
     * The alternative to `deliveryChannelId`, for a workspace that has never set
     * one up: an address to create a channel from, in the same request. Checked
     * for shape in the handler by the same `channelSecretProblem` the standalone
     * route uses, not here — z.string().email() would be a second opinion that
     * can drift from it.
     */
    deliveryEmail: z.string().optional(),
    scheduleCron: z.string().min(1),
    timezone: z.string().default("UTC"),
    /**
     * `schedule` unless asked otherwise, which is what every routine was before
     * 0055. A webhook trigger is only valid on a routine with no source of its
     * own; the database says so with a CHECK, and 0027's trigger means it can
     * never be granted to an existing RSS routine afterwards.
     */
    triggerKind: z.enum(["schedule", "webhook", "both", "event"]).default("schedule"),
    /**
     * What an `event` routine waits for (0109), chosen in the same dialog so a
     * routine is never created waiting for nothing. Required with `event` and
     * refused without it; checked against the catalogue and the connections
     * before the routine is inserted, so a bad choice leaves nothing behind.
     */
    event: eventChoiceSchema.optional(),
    /**
     * Where a delivered summary is kept, or null to keep nothing — which is the
     * default and what every routine did before 0056.
     *
     * Not validated here beyond its shape. The bundle has to be one in the
     * routine's own workspace, and 0056's policies are what say so: the subquery
     * resolves through `knowledge_bundles`' RLS, so a bundle in somebody else's
     * workspace is refused by the same mechanism that refuses somebody else's
     * agent. Checking it here as well would be a second opinion that can drift
     * from the one that counts.
     */
    outputBundleId: z.string().uuid().nullable().optional(),
    /** Bounded here as well as by 0056's CHECK, so the refusal names the field. */
    outputRetention: z.number().int().min(1).max(520).optional(),
    /**
     * A series' length, decided once at creation (0074) — `updateSchema` below
     * does not get this, the same way it does not get `sourceKind`. Null or
     * omitted means it runs until somebody stops it.
     */
    endsAfterRuns: z.number().int().min(1).max(365).nullish(),
    ...runChoices,
  })
  // Exactly one. Both is a caller that has not decided, and neither is a routine
  // the database would refuse anyway — `delivery_channel_id` is `not null`.
  .refine((v) => (v.deliveryChannelId === undefined) !== (v.deliveryEmail === undefined), {
    message: "send either deliveryChannelId or deliveryEmail, not both",
  })
  .refine((v) => (v.triggerKind === "event") === (v.event !== undefined), {
    message: "an event routine needs an event, and only an event routine takes one",
  });

// agentId and workspaceId are deliberately absent from updateSchema. The
// database is the real boundary — routines_update_own's WITH CHECK now carries
// the same workspace, agent and channel guards as the INSERT policy — but there
// is no reason for this endpoint to offer a re-target it has no use for.
const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    instruction: z.string().min(1).optional(),
    scheduleCron: z.string().min(1).optional(),
    timezone: z.string().optional(),
    status: z.enum(["active", "paused"]).optional(),
    visibility: z.enum(["private", "shared"]).optional(),
    deliveryChannelId: z.string().uuid().optional(),
    triggerKind: z.enum(["schedule", "webhook", "both", "event"]).optional(),
    // Nullable as well as optional, and the difference is the feature: absent
    // means "leave filing as it is", null means "stop filing". A field that
    // could only be absent or a uuid would let somebody turn filing on and
    // never off.
    outputBundleId: z.string().uuid().nullable().optional(),
    outputRetention: z.number().int().min(1).max(520).optional(),
    /**
     * Whether a scheduled run may use the browser, and what it carries (0100).
     * `site` needs `browserSite`, here or already on the row; the host is
     * normalised by `siteHostOf`, the function a saved login's host went
     * through, so the two are compared without a second normaliser.
     */
    browserAccess: z.enum(["off", "all", "site"]).optional(),
    browserSite: z.string().max(300).nullable().optional(),
    ...runChoices,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

/**
 * What the engine reads back off the row.
 *
 * One key per kind rather than a bag of everything the request happened to
 * carry: a `connection` routine that also stored a leftover `url` would look,
 * to anyone reading the row later, like it might fetch one.
 */
routines.get("/routines", async (c) => {
  const db = c.get("db");
  const { data, error } = await db
    .from("routines")
    .select(ROUTINE_SELECT)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load routines" }, 500);
  const rows = data ?? [];

  // What the list says under each name (A7): who made it, who paused it, and
  // how its last run went. Two reads for the whole list, both the caller's.
  const ids = rows.map((r) => r.id as string);
  const people = [
    ...new Set(rows.flatMap((r) => [r.user_id, r.paused_by]).filter(Boolean) as string[]),
  ];
  const [last, profiles] = await Promise.all([
    ids.length > 0
      ? db.rpc("routine_last_runs", { p_routine_ids: ids })
      : Promise.resolve({ data: [], error: null }),
    people.length > 0
      ? db.from("profiles").select("id, name").in("id", people)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const lastRuns = new Map(
    ((last.data ?? []) as LastRunRow[]).map((r) => [r.routine_id, r] as const),
  );
  const names = new Map(
    ((profiles.data ?? []) as Array<{ id: string; name: string | null }>).map(
      (p) => [p.id, p.name?.trim() || null] as const,
    ),
  );
  const now = Date.now();

  return c.json(
    rows.map((row) => {
      const run = lastRuns.get(row.id as string);
      return {
        ...mapRoutine(row),
        ownerName: names.get(row.user_id as string) ?? null,
        pausedByName: row.paused_by ? (names.get(row.paused_by as string) ?? null) : null,
        lastRun: run
          ? {
              id: run.id,
              status: run.status,
              at: Date.parse(run.finished_at ?? run.started_at),
              sessionId: run.session_id,
            }
          : null,
        runningSince: runningSince(row, run, now),
      };
    }),
  );
});

type LastRunRow = {
  routine_id: string;
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  session_id: string | null;
};

/** How long a claim may be held before it reads as a crash rather than a run. */
const RUNNING_WINDOW_MS = 30 * 60 * 1000;

/**
 * When the run under way started, or null: a claim the engine took in the
 * last half hour (`claimed_at`, which `finish` clears), or a run that wrote
 * its report and is waiting on the browser (0100). There is no step count for
 * a routine — only a chat turn reports one (0122).
 */
export function runningSince(
  row: { claimed_at?: string | null },
  last: { status: string; started_at: string } | undefined,
  now: number,
): number | null {
  const claimed = row.claimed_at ? Date.parse(row.claimed_at) : NaN;
  if (Number.isFinite(claimed) && now - claimed < RUNNING_WINDOW_MS) return claimed;
  if (last?.status === "waiting") return Date.parse(last.started_at);
  return null;
}

routines.post("/routines", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const db = c.get("db");
  const { data: agent } = await db
    .from("agents")
    .select("workspace_id")
    .eq("id", body.agentId)
    .single();
  if (!agent) return c.json({ error: "agent not found" }, 404);

  const user = c.get("user");
  // The agent's workspace, not the caller's *active* one (`getActiveWorkspaceId`,
  // which the standalone `POST /delivery-channels` uses below): a delivery
  // channel belongs to a person, not a workspace — 0019 says so outright, and
  // `routines_insert_own` only checks `dc.user_id = auth.uid()`, never a
  // workspace match. `delivery_channels.workspace_id` is provenance nothing
  // reads back; for a channel minted inside a routine, the agent's workspace
  // is simply the more useful thing to have recorded, not a requirement.
  const workspaceId = agent.workspace_id as string;

  // Checked before anything is written — the channel minted below included —
  // so an event this deployment cannot listen for, or an app that is not
  // connected, refuses the whole request instead of leaving a routine that
  // waits for nothing.
  //
  // Open to an API key, unlike `PUT /routines/:id/event` below. A routine a
  // key creates carries the key (0088), and revoking the key pauses it — at
  // which point the sweeper tells the provider to stop. What a key starts ends
  // with it, which is not true of a listener a key attaches to somebody's
  // session-made routine.
  let eventChoice: EventChoice | undefined;
  if (body.event) {
    const chosen = await chosenEvent(c, workspaceId, body.event);
    if ("refused" in chosen) return chosen.refused;
    eventChoice = chosen.choice;
  }

  // A workspace that has never set a channel up cannot otherwise finish this
  // dialog, and a new workspace is exactly that workspace. The address is the
  // caller's own and arrives from a field they confirmed; it is validated by
  // the same `channelSecretProblem` the standalone route uses and encrypted
  // by the same `encryptSecret`, because this is a second caller of that path
  // and not a second path.
  let deliveryChannelId = body.deliveryChannelId;
  // Set only when this request minted a new channel — the thing to undo if
  // the routine insert below fails, so a schedule the parser can't read or a
  // url the SSRF guard refuses doesn't leave an encrypted address nobody can
  // reach, and correcting the field and resubmitting doesn't mint a second one
  // on top of it.
  let createdChannelId: string | undefined;
  let unconfirmedAddress: string | undefined;
  if (body.deliveryEmail !== undefined) {
    const problem = channelSecretProblem("email", body.deliveryEmail, ownHostsFrom(c.env));
    if (problem) return c.json({ error: problem }, 400);
    // The same rule as the standalone route: the caller's own address is
    // confirmed now, any other waits for the link mailed below.
    const start = await emailAddressStart(c.env, user.id, body.deliveryEmail);
    if ("refused" in start) return c.json({ error: start.refused }, 429);
    if (!start.confirmedAt) unconfirmedAddress = body.deliveryEmail;
    const { data, error } = await serviceClient(c.env)
      .from("delivery_channels")
      .insert({
        workspace_id: workspaceId,
        user_id: user.id,
        kind: "email",
        label: maskSecret("email", body.deliveryEmail),
        secret_ciphertext: await encryptSecret(body.deliveryEmail, c.env.ROUTINE_SECRET_KEY),
        api_key_id: apiKeyIdOf(c),
        confirmed_at: start.confirmedAt,
      })
      .select("id")
      .single();
    if (error) return c.json({ error: "could not set up that address" }, 500);
    deliveryChannelId = data.id as string;
    createdChannelId = deliveryChannelId;
  }

  // The one insert site, shared with the tool an agent uses to propose a
  // routine mid-conversation — see `lib/routines/create.ts` for why there is
  // exactly one.
  const created = await createRoutine(
    db,
    {
      agentId: body.agentId,
      workspaceId,
      userId: user.id,
      name: body.name,
      sourceKind: body.sourceKind,
      sourceUrl: body.sourceUrl ?? null,
      connectionId: body.connectionId ?? null,
      instruction: body.instruction,
      // The schema's refine guarantees exactly one of `deliveryChannelId` and
      // `deliveryEmail` arrived, and the branch above resolves the latter to
      // a freshly created channel's id — by here, one is always set.
      deliveryChannelId: deliveryChannelId as string,
      scheduleCron: body.scheduleCron,
      timezone: body.timezone,
      triggerKind: body.triggerKind,
      outputBundleId: body.outputBundleId ?? null,
      ...(body.outputRetention !== undefined ? { outputRetention: body.outputRetention } : {}),
      endsAfterRuns: body.endsAfterRuns ?? null,
      ...(body.deliverInbox !== undefined ? { deliverInbox: body.deliverInbox } : {}),
      model: body.model ?? null,
      reasoningEffort: body.reasoningEffort ?? null,
    },
    ownHostsFrom(c.env),
  );
  if (!created.ok) {
    if (createdChannelId) {
      // Logged, not returned: the caller's error is the routine's, and a
      // failed cleanup must not replace it. But it must leave a trace —
      // covan-cloud#310 — or the orphaned encrypted address is invisible.
      const { error: rollbackError } = await serviceClient(c.env)
        .from("delivery_channels")
        .delete()
        .eq("id", createdChannelId);
      if (rollbackError) {
        console.error(
          `routine create failed and its new delivery channel ${createdChannelId} could not be removed`,
          rollbackError,
        );
      }
    }
    return c.json({ error: created.message }, created.status);
  }
  // The subscription, once there is a routine to hang it on. A failure to
  // REACH the provider is not a failure here — the row is written `failed`
  // with a sentence and the sweeper keeps trying — but a failure to write the
  // row at all is, and the routine goes with it: a routine waiting for an
  // event nobody recorded would wait forever and say it was fine.
  let row = created.row;
  if (eventChoice) {
    try {
      await replaceSubscription(c.env, row.id, eventChoice);
    } catch (err) {
      console.error("could not record a new routine's event", err);
      await db.from("routines").delete().eq("id", row.id);
      if (createdChannelId) {
        await serviceClient(c.env).from("delivery_channels").delete().eq("id", createdChannelId);
      }
      return c.json({ error: "could not set up that event" }, 500);
    }
    const { data: reread } = await db
      .from("routines")
      .select(ROUTINE_SELECT)
      .eq("id", row.id)
      .maybeSingle();
    if (reread) row = reread as typeof row;
  }

  // Asked only once the routine exists, so a request that failed above has
  // mailed nobody.
  const confirmation =
    createdChannelId && unconfirmedAddress
      ? await askNewAddress(c.env, { id: createdChannelId, user_id: user.id }, unconfirmedAddress)
      : undefined;
  return c.json({ ...mapRoutine(row), ...(confirmation ? { confirmation } : {}) }, 201);
});

routines.patch("/routines/:id", async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const db = c.get("db");
  const { data: current, error: loadError } = await db
    .from("routines")
    .select("schedule_cron, timezone, status, browser_site")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (loadError) return c.json({ error: "failed to load routine" }, 500);
  if (!current) return c.json({ error: "routine not found" }, 404);

  // A finished series stays finished — covan-cloud#307. `updateSchema` offers
  // `active` and `paused`, which is right for a running routine and wrong for
  // one that completed: resuming it would restart a series the product has
  // no way to restart, and `finish` would re-complete it after one more
  // delivery. Refused here rather than in the schema, because whether the
  // transition is allowed depends on the row, not on the request. Every
  // other field stays editable — renaming a finished routine is harmless.
  if (body.status !== undefined && current.status === "completed") {
    return c.json({ error: "this routine has finished its series and cannot be resumed" }, 409);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) patch.name = body.name;
  if (body.instruction !== undefined) patch.instruction = body.instruction;
  if (body.visibility !== undefined) patch.visibility = body.visibility;
  if (body.deliveryChannelId !== undefined) patch.delivery_channel_id = body.deliveryChannelId;
  // The CHECK in 0055 refuses `webhook` or `both` on a routine that watches
  // something; the error path below turns that into a 400 rather than a 500.
  if (body.triggerKind !== undefined) patch.trigger_kind = body.triggerKind;
  // `!== undefined` rather than a truthiness test, so an explicit null turns
  // filing off instead of being read as "no change".
  if (body.outputBundleId !== undefined) patch.output_bundle_id = body.outputBundleId;
  if (body.outputRetention !== undefined) patch.output_retention = body.outputRetention;
  if (body.deliverInbox !== undefined) patch.deliver_inbox = body.deliverInbox;
  if (body.model !== undefined) patch.model = body.model;
  if (body.reasoningEffort !== undefined) patch.reasoning_effort = body.reasoningEffort;

  // The browser (0100). A site that is not a host is refused rather than
  // stored: a login nothing can match is a setting that silently never works.
  if (body.browserSite !== undefined) {
    const site =
      body.browserSite === null || !body.browserSite.trim() ? null : siteHostOf(body.browserSite);
    if (body.browserSite !== null && body.browserSite.trim() && !site) {
      return c.json({ error: "the browser site must be a website's host, like linkedin.com" }, 400);
    }
    patch.browser_site = site;
  }
  if (body.browserAccess !== undefined) {
    const site = body.browserSite !== undefined ? patch.browser_site : current.browser_site;
    if (body.browserAccess === "site" && !site) {
      return c.json({ error: "name the one site this routine may sign in to" }, 400);
    }
    patch.browser_access = body.browserAccess;
  }

  // Validate the pair that will actually be in effect, not just the field that
  // changed — a timezone the cron parser cannot resolve leaves the executor
  // unable to compute a next run at all, and a timezone-only patch that skips
  // validation writes an unvalidated string straight through: the routine
  // never fails loudly, it just stops advancing and re-claims every tick
  // without ever reaching the failure counter that would auto-pause it.
  const cron = body.scheduleCron ?? current.schedule_cron;
  const timezone = body.timezone ?? current.timezone;
  const scheduleChanged = body.scheduleCron !== undefined || body.timezone !== undefined;

  if (scheduleChanged) {
    if (!isValidCron(cron, timezone)) return c.json({ error: "unusable schedule" }, 400);
    patch.schedule_cron = cron;
    patch.timezone = timezone;
    patch.next_run_at = nextRunAt(cron, timezone, new Date()).toISOString();
  }

  // Resuming clears the failure state, otherwise one more error re-pauses it.
  // This comes after the schedule block so a resume's "fire promptly" wins
  // over a schedule change's computed next_run_at.
  if (body.status !== undefined) {
    patch.status = body.status;
    if (body.status === "active") {
      patch.paused_reason = null;
      patch.consecutive_failures = 0;
      patch.next_run_at = new Date().toISOString();
    }
  }

  const { data, error } = await db
    .from("routines")
    .update(patch)
    .eq("id", c.req.param("id"))
    .select(ROUTINE_SELECT)
    .maybeSingle();

  if (error) {
    // The same classification the create path makes, and for the same reason:
    // `routines_update_own`'s WITH CHECK carries every guard the INSERT policy
    // does, so a patch that repoints a routine at another workspace's bundle
    // comes back as a policy refusal rather than as a missing row. Reporting
    // that as a 500 would tell the caller the server is broken when what is
    // broken is what they asked for.
    if (insertErrorStatus(error) === 400) {
      return c.json(
        {
          error:
            "the delivery channel or output bundle is not available to you in this workspace, " +
            "or this source cannot have a webhook trigger",
        },
        400,
      );
    }
    return c.json({ error: "failed to update routine" }, 500);
  }
  if (!data) return c.json({ error: "routine not found" }, 404);

  // Pausing, resuming and changing how it starts all move what the provider
  // should be doing (0109). Told now, so a paused routine stops being sent
  // events before the next tick rather than after; awaited, so the answer
  // carries the subscription as it now stands. Best-effort: the PATCH is
  // committed, and a provider that cannot be reached is the sweeper's to
  // catch — `claim_event_subscriptions` sees exactly this drift.
  // Only for a routine that is, or just stopped being, an event one: a pause
  // on an ordinary schedule has no provider to tell.
  if (
    (body.status !== undefined && data.trigger_kind === "event") ||
    body.triggerKind !== undefined
  ) {
    try {
      const synced = await syncSubscription(c.env, data.id as string);
      if (synced.status === null) return c.json(mapRoutine({ ...data, event: null }));
      const { data: reread } = await db
        .from("routines")
        .select(ROUTINE_SELECT)
        .eq("id", data.id)
        .maybeSingle();
      if (reread) return c.json(mapRoutine(reread));
    } catch (err) {
      console.error("could not bring a routine's event subscription in step", err);
    }
  }
  return c.json(mapRoutine(data));
});

// POST /routines/:id/run — run it now instead of waiting for the schedule.
//
// The engine only looks every few minutes — five on the Cloudflare trigger,
// ROUTINE_TICK_MS on Node — so without this the only way to find out whether a
// routine works is to create it and wait. That makes every mistake — a feed
// that 404s, a webhook that was revoked, an instruction that produces nothing
// useful — cost a full round trip through the scheduler to discover.
//
// Overlapping with a cron tick is safe: the executor reserves delivery keys
// before it sends, so the second run of a pair delivers nothing.
routines.post("/routines/:id/run", async (c) => {
  const db = c.get("db");

  // Read through the caller's own client first. RLS already limits this to
  // routines they can see; the ownership check then narrows it to their own,
  // because running a routine spends the owner's LLM budget and delivers to
  // the owner's channel — neither is a teammate's to trigger.
  const { data: routine, error } = await db
    .from("routines")
    .select("*")
    .eq("id", c.req.param("id"))
    .maybeSingle();

  if (error) return c.json({ error: "failed to load routine" }, 500);
  if (!routine) return c.json({ error: "routine not found" }, 404);
  if (routine.user_id !== c.get("user").id) {
    return c.json({ error: "only the owner can run this routine" }, 403);
  }

  // The executor checks credits too, but it can only record the refusal as a
  // skipped run. Checking here turns "nothing happened" into a 402 the person
  // who pressed the button can read. The routine's workspace pays.
  const denied = await guardCredits(c, routine.workspace_id as string);
  if (denied) return denied;

  // Email delivery goes through Resend, whose key is a secret on whichever
  // account this Worker runs on. Saying so beats a run that fails with a bare
  // 401 from an API the user has never heard of.
  if (!c.env.RESEND_API_KEY || !c.env.RESEND_FROM) {
    const { data: channel } = await db
      .from("delivery_channels")
      .select("kind")
      .eq("id", routine.delivery_channel_id)
      .maybeSingle();
    if (channel?.kind === "email") {
      return c.json({ error: "email delivery is not configured on this worker" }, 503);
    }
  }

  const result = await runOneRoutine(c.env, routine as RoutineRow);
  return c.json(result);
});

routines.delete("/routines/:id", async (c) => {
  const db = c.get("db");
  // An event routine is unsubscribed at its provider first, because the
  // delete cascades its subscription row and with it the only record of what
  // to unsubscribe (0109). Only once the caller's own client has shown the
  // routine is theirs — the same rule `routines_delete_own` is about to apply
  // — so nobody can unsubscribe a routine they could not delete.
  const { data: own } = await db
    .from("routines")
    .select("id, trigger_kind")
    .eq("id", c.req.param("id"))
    .eq("user_id", c.get("user").id)
    .maybeSingle();
  if (own?.trigger_kind === "event") {
    try {
      await releaseSubscription(c.env, own.id as string);
    } catch (err) {
      // Not a reason to keep a routine somebody deleted. What is left at the
      // provider is 0109's orphan, which its adapter cancels on its next
      // delivery.
      console.error("could not release a deleted routine's event subscription", err);
    }
  }
  // Into the thirty-day trash (0125); it comes back paused if restored.
  const failure = await callDeletionFn(
    db,
    "soft_delete_routine",
    { p_routine_id: c.req.param("id") },
    "failed to delete routine",
  );
  if (failure) {
    const message =
      failure.status === 403 ? "only whoever made a routine can delete it" : failure.message;
    return c.json({ error: message }, failure.status);
  }
  return c.body(null, 204);
});

// GET /routines/:id/runs — history. A 'skipped' row is the answer to "why
// didn't it send me anything?", so it is shown, not hidden.
routines.get("/routines/:id/runs", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("routine_runs")
    .select("*")
    .eq("routine_id", c.req.param("id"))
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) return c.json({ error: "failed to load runs" }, 500);
  // What each run cost (A7's Credits column), in the unit this deployment
  // speaks: credits where it sells them, dollars where it does not.
  const priced = priceIn(quoteOf(c.get("entitlements")));
  return c.json(
    (data ?? []).map((row) => ({
      ...mapRoutineRun(row),
      cost: row.model ? { amount: priced.amount(runCostUsd(row)), unit: priced.unit } : null,
    })),
  );
});

// ---- costs, tests and the list's footer (0130) ------------------------------

/** The columns a run is priced from. */
type RunCostRow = {
  model: string | null;
  tokens: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
};

const RUN_COST_COLUMNS =
  "routine_id, model, tokens, prompt_tokens, completion_tokens, cached_tokens";

/**
 * A run's price in dollars, from its own model unless another is named — the
 * editor asks what the same work would cost on the model it is about to pick.
 *
 * A run from before 0130 kept its total alone, and is priced as if all of it
 * was read: the cheaper side of the bill, so an old estimate errs low rather
 * than inventing an output it cannot know.
 */
export function runCostUsd(row: RunCostRow, model?: string): number {
  const m = model ?? row.model ?? "";
  if (row.prompt_tokens == null) return estimateCostUsd(m, Number(row.tokens) || 0, 0);
  return estimateCostUsd(
    m,
    Number(row.prompt_tokens) || 0,
    Number(row.completion_tokens) || 0,
    Number(row.cached_tokens) || 0,
  );
}

/** Dollars into what this deployment shows: whole credits, or cents. */
function priceIn(quote: ((usd: number) => number) | null): {
  unit: "credits" | "usd";
  amount: (usd: number) => number;
} {
  return quote
    ? { unit: "credits", amount: (usd) => Math.round(quote(usd)) }
    : { unit: "usd", amount: (usd) => Math.round(usd * 100) / 100 };
}

/**
 * The quarter and three quarters of what similar runs cost — "About 15 to 25
 * credits per run". Fewer than four runs give their lowest and highest
 * instead, which is all a handful can honestly say.
 */
export function costRange(costs: number[]): { low: number; high: number } | null {
  if (costs.length === 0) return null;
  const sorted = [...costs].sort((a, b) => a - b);
  if (sorted.length < 4) return { low: sorted[0]!, high: sorted[sorted.length - 1]! };
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { low: at(0.25), high: at(0.75) };
}

/** How many times a schedule fires in the next thirty days, up to `cap`. */
export function runsInThirtyDays(cron: string, timezone: string, from: Date, cap = 999): number {
  const end = from.getTime() + 30 * 24 * 60 * 60 * 1000;
  let at = from;
  let count = 0;
  while (count < cap) {
    at = nextRunAt(cron, timezone, at);
    if (at.getTime() > end) break;
    count++;
  }
  return count;
}

/** A row of `routine_run_totals` (0130). */
type RunTotalRow = {
  status: string;
  model: string | null;
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  unsplit_tokens: number;
};

const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

// GET /routines/stats — the list's footer (A7): "14 runs in the last 7 days ·
// 13 done, 1 failed · 118 credits", over the runs the caller can see.
routines.get("/routines/stats", async (c) => {
  const parsed = statsQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no active workspace" }, 400);

  const { data, error } = await c.get("db").rpc("routine_run_totals", {
    p_workspace_id: workspaceId,
    p_days: parsed.data.days,
  });
  if (error) return c.json({ error: "failed to count runs" }, 500);

  const priced = priceIn(quoteOf(c.get("entitlements")));
  let runs = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let usd = 0;
  for (const row of (data ?? []) as RunTotalRow[]) {
    const n = Number(row.runs) || 0;
    runs += n;
    if (row.status === "ok") done += n;
    else if (row.status === "failed") failed += n;
    else if (row.status === "skipped") skipped += n;
    // Summed by model, and a price is linear in tokens, so each sum is priced
    // as one run of its size. What was kept before 0130 as a total alone is
    // priced as read, as `runCostUsd` prices a single old run.
    usd += runCostUsd({
      model: row.model,
      tokens: null,
      prompt_tokens: Number(row.prompt_tokens) || 0,
      completion_tokens: row.completion_tokens,
      cached_tokens: row.cached_tokens,
    });
    usd += runCostUsd({ model: row.model, tokens: Number(row.unsplit_tokens) || 0 });
  }
  return c.json({
    days: parsed.data.days,
    runs,
    done,
    failed,
    skipped,
    cost: priced.amount(usd),
    unit: priced.unit,
  });
});

const estimateQuery = z.object({
  agentId: z.string().uuid(),
  /** The routine being edited, whose own runs are the best evidence. */
  routineId: z.string().uuid().optional(),
  /** The model the editor has picked, to reprice the evidence at. */
  model: z.enum(MODEL_IDS).optional(),
  cron: z.string().max(120).optional(),
  timezone: z.string().max(64).optional(),
});

// GET /routines/estimate — "About 15 to 25 credits per run · 4 runs a month.
// Based on the Daily support digest, which reads the same tickets." (A28)
//
// Read from what the caller can see, in order: this routine's own delivered
// runs; the agent's routine with the most of them; the agent's replies. Each
// is real work of the same agent, priced at the model the editor has picked.
// No evidence is an answer too — `low` and `high` come back null.
routines.get("/routines/estimate", async (c) => {
  const parsed = estimateQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const q = parsed.data;
  const db = c.get("db");

  let basedOn: { kind: "routine"; routineId: string; name: string } | { kind: "replies" } | null =
    null;
  let samples: RunCostRow[] = [];

  const { data: siblings, error: siblingsError } = await db
    .from("routines")
    .select("id, name")
    .eq("agent_id", q.agentId);
  if (siblingsError) return c.json({ error: "failed to read routines" }, 500);
  const routineIds = (siblings ?? []).map((r) => r.id as string);

  if (routineIds.length > 0) {
    const { data: runs, error } = await db
      .from("routine_runs")
      .select(RUN_COST_COLUMNS)
      .in("routine_id", routineIds)
      .eq("status", "ok")
      .not("model", "is", null)
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) return c.json({ error: "failed to read runs" }, 500);
    const byRoutine = new Map<string, RunCostRow[]>();
    for (const run of (runs ?? []) as Array<RunCostRow & { routine_id: string }>) {
      byRoutine.set(run.routine_id, [...(byRoutine.get(run.routine_id) ?? []), run]);
    }
    const own = q.routineId ? byRoutine.get(q.routineId) : undefined;
    const pick = own?.length
      ? q.routineId!
      : [...byRoutine.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
    if (pick) {
      samples = (byRoutine.get(pick) ?? []).slice(0, 20);
      const name = (siblings ?? []).find((r) => r.id === pick)?.name as string | undefined;
      basedOn = { kind: "routine", routineId: pick, name: name ?? "" };
    }
  }

  if (samples.length === 0) {
    const { data: replies, error } = await db
      .from("messages")
      .select(
        "model, prompt_tokens, completion_tokens, cached_tokens, chat_sessions!inner(agent_id)",
      )
      .eq("chat_sessions.agent_id", q.agentId)
      .eq("role", "assistant")
      .not("prompt_tokens", "is", null)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) return c.json({ error: "failed to read replies" }, 500);
    samples = (replies ?? []).map((r) => ({
      model: r.model as string | null,
      tokens: null,
      prompt_tokens: r.prompt_tokens as number | null,
      completion_tokens: r.completion_tokens as number | null,
      cached_tokens: r.cached_tokens as number | null,
    }));
    if (samples.length > 0) basedOn = { kind: "replies" };
  }

  const priced = priceIn(quoteOf(c.get("entitlements")));
  const range = costRange(samples.map((s) => runCostUsd(s, q.model)));
  // A run that costs something reads as at least one credit: "About 0 to 0"
  // would say it is free.
  const amount = (usd: number) =>
    priced.unit === "credits" && usd > 0 ? Math.max(1, priced.amount(usd)) : priced.amount(usd);
  const timezone = q.timezone ?? "UTC";

  return c.json({
    low: range ? amount(range.low) : null,
    high: range ? amount(range.high) : null,
    unit: priced.unit,
    runsPerMonth:
      q.cron && isValidCron(q.cron, timezone)
        ? runsInThirtyDays(q.cron, timezone, new Date())
        : null,
    basedOn: samples.length > 0 ? basedOn : null,
  });
});

// PUT /routines/:id/channels — where a run goes after the primary (0130).
// The whole list, replaced: what the editor shows is what is saved.
const channelsSchema = z.object({ channelIds: z.array(z.string().uuid()).max(10) });

routines.put("/routines/:id/channels", async (c) => {
  const parsed = channelsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const db = c.get("db");
  const id = c.req.param("id");

  const { data: routine, error: loadError } = await db
    .from("routines")
    .select("id, user_id, delivery_channel_id")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return c.json({ error: "failed to load routine" }, 500);
  if (!routine) return c.json({ error: "routine not found" }, 404);
  // The policies say the same; saying it here names the reason.
  if (routine.user_id !== c.get("user").id) {
    return c.json({ error: "only whoever made a routine can change where it delivers" }, 403);
  }

  // The primary is not listed twice: it is sent to first, whatever this says.
  const wanted = [...new Set(parsed.data.channelIds)].filter(
    (channelId) => channelId !== routine.delivery_channel_id,
  );
  const { data: current, error: currentError } = await db
    .from("routine_channels")
    .select("delivery_channel_id")
    .eq("routine_id", id);
  if (currentError) return c.json({ error: "failed to load the routine's channels" }, 500);
  const have = new Set((current ?? []).map((r) => r.delivery_channel_id as string));
  const add = wanted.filter((channelId) => !have.has(channelId));
  const remove = [...have].filter((channelId) => !wanted.includes(channelId));

  if (remove.length > 0) {
    const { error } = await db
      .from("routine_channels")
      .delete()
      .eq("routine_id", id)
      .in("delivery_channel_id", remove);
    if (error) return c.json({ error: "failed to update the routine's channels" }, 500);
  }
  if (add.length > 0) {
    const { error } = await db
      .from("routine_channels")
      .insert(add.map((channelId) => ({ routine_id: id, delivery_channel_id: channelId })));
    if (error) {
      return insertErrorStatus(error) === 400
        ? c.json({ error: "one of those channels is not yours, or was turned off" }, 400)
        : c.json({ error: "failed to update the routine's channels" }, 500);
    }
  }
  return c.json({ channelIds: wanted });
});

// POST /routines/:id/test — "Run a test" (A28). The same run as Run now, for
// the same person and paid the same way, that sends nothing anywhere: the
// result is a private thread for its owner, and nothing about the routine
// moves (`isTest` in lib/routines/executor.ts lists what it leaves alone).
routines.post("/routines/:id/test", async (c) => {
  const db = c.get("db");
  const { data: routine, error } = await db
    .from("routines")
    .select("*")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load routine" }, 500);
  if (!routine) return c.json({ error: "routine not found" }, 404);
  // Run now's rule, for Run now's reason: it spends the owner's budget.
  if (routine.user_id !== c.get("user").id) {
    return c.json({ error: "only the owner can test this routine" }, 403);
  }
  const denied = await guardCredits(c, routine.workspace_id as string);
  if (denied) return denied;

  const result = await runTestRoutine(c.env, routine as RoutineRow);

  // The row the test wrote, read back as its owner, so the editor can open
  // the thread it made.
  const { data: run } = await db
    .from("routine_runs")
    .select("*")
    .eq("routine_id", routine.id)
    .eq("triggered_by", "test")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return c.json({ ...result, run: run ? mapRoutineRun(run) : null });
});

export { routines };

// ---- ingest triggers -------------------------------------------------------
//
// The token itself is minted and hashed here, with the service role, for the
// same reason a delivery channel's secret is: `routine_triggers.token_hash` is
// granted to no client role at all (0055), so a caller's own client can neither
// write it nor read it back. Every one of these checks ownership through the
// caller's own client first, so RLS decides who the routine belongs to and this
// file only decides what to do about it.
//
// Reading a trigger's *existence* does go through the caller's client, because
// there the policy is the whole answer: `routine_triggers_select_own` returns
// the row to the routine's owner and to nobody else — deliberately narrower
// than the routine's own visibility, because sharing a routine shares what it
// does, not the ability to fire it.

/** Is the webhook wired up, and has anything ever used it? Never the token. */
routines.get("/routines/:id/trigger", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("routine_triggers")
    .select("routine_id, created_at, last_used_at")
    .eq("routine_id", c.req.param("id"))
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return c.json({ error: "invalid routine id" }, 400);
    return c.json({ error: "failed to load the trigger" }, 500);
  }
  if (!data) return c.json({ configured: false });

  return c.json({
    configured: true,
    createdAt: Date.parse(data.created_at as string),
    lastUsedAt: data.last_used_at ? Date.parse(data.last_used_at as string) : null,
  });
});

/**
 * Mint an ingest token, or replace the one this routine has.
 *
 * One endpoint for both because they are the same act: the row's primary key is
 * the routine, so writing is an upsert and rotating is what writing a second
 * time means. Splitting them would suggest a rotation keeps something, and it
 * keeps nothing — the old token stops working the moment this returns.
 */
routines.post("/routines/:id/trigger", async (c) => {
  const id = c.req.param("id");

  // Through the caller's own client: if RLS does not return the row, the answer
  // is 404 for the same reason it is everywhere else in this API — a row you
  // cannot see is absent, not forbidden.
  const { data: routine, error } = await c
    .get("db")
    .from("routines")
    .select("id, trigger_kind")
    .eq("id", id)
    .eq("user_id", c.get("user").id)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return c.json({ error: "invalid routine id" }, 400);
    return c.json({ error: "failed to load routine" }, 500);
  }
  if (!routine) return c.json({ error: "routine not found" }, 404);

  // Refused rather than switched on the caller's behalf. Changing how a routine
  // is started is a decision about a thing that runs unattended, and quietly
  // making one because somebody pressed a button next to it is the kind of
  // helpfulness nobody remembers having agreed to.
  // By what may be poked, so an `event` routine (0109) is refused too: its
  // way in is the provider, and a URL beside it would be a second door the
  // owner did not ask for.
  if (routine.trigger_kind !== "webhook" && routine.trigger_kind !== "both") {
    return c.json({ error: "this routine is not set to accept webhook triggers" }, 400);
  }

  const { token, tokenHash } = generateIngestToken();
  const { error: writeError } = await serviceClient(c.env)
    .from("routine_triggers")
    .upsert(
      // The key, or null: a token minted by a session replaces one a key made,
      // and stops dying with that key.
      {
        routine_id: id,
        token_hash: await tokenHash,
        last_used_at: null,
        api_key_id: apiKeyIdOf(c),
      },
      { onConflict: "routine_id" },
    );

  if (writeError) return c.json({ error: "failed to create the trigger" }, 500);

  // The only response that carries it. The database holds a SHA-256, so nobody
  // — including us — can show it again; the path is returned with it so the
  // interface does not have to know how this endpoint is spelled.
  return c.json({ token, path: `/routine-hooks/${token}` }, 201);
});

/** Turn the webhook off. The routine keeps running on its schedule, if it has one. */
routines.delete("/routines/:id/trigger", async (c) => {
  // The caller's own client: 0055 grants `authenticated` a DELETE and
  // `routine_triggers_delete_own` scopes it to the routine's owner, so the
  // database is the whole check and there is nothing here for the service role
  // to do.
  const { error } = await c
    .get("db")
    .from("routine_triggers")
    .delete()
    .eq("routine_id", c.req.param("id"));

  if (error) {
    if (error.code === "22P02") return c.json({ error: "invalid routine id" }, 400);
    return c.json({ error: "failed to remove the trigger" }, 500);
  }
  return c.body(null, 204);
});

// ---- event triggers (0109) --------------------------------------------------
//
// What an `event` routine waits for. The row lives in
// `routine_event_subscriptions`, which no client role may write and whose
// provider id and secret no client may read, so every write here goes
// through `lib/routines/events/lifecycle.ts` with the service role — after
// the caller's own client has shown the routine is theirs. Reading what a
// routine waits for needs none of this: `ROUTINE_SELECT` embeds it, and the
// policy hands it to the owner alone.

/**
 * A person's pick, checked: a catalogue entry this deployment can listen for,
 * a config its schema accepts, and the connection it needs, found through the
 * caller's own client and recorded as `config.connectionId`.
 */
async function chosenEvent(
  c: Context<AppEnv>,
  workspaceId: string,
  input: { type: string; config: Record<string, unknown> },
): Promise<{ choice: EventChoice } | { refused: Response }> {
  const parsed = parseEventChoice(EVENT_REGISTRY, input.type, input.config);
  if (!parsed.ok) return { refused: c.json({ error: parsed.error }, 400) };
  const { def, config } = parsed.choice;
  if (!canListenFor(EVENT_REGISTRY, c.env, def)) {
    return { refused: c.json({ error: "this deployment cannot listen for that event" }, 400) };
  }
  const requirement = await checkRequirement(c.get("db"), workspaceId, def.requires, def.app);
  if (!requirement.ok) return { refused: c.json({ error: requirement.error }, 409) };
  return {
    choice: {
      def,
      config: requirement.connectionId
        ? { ...config, connectionId: requirement.connectionId }
        : config,
    },
  };
}

/**
 * The routine, if the caller owns it — through their own client, so RLS
 * decides whose it is and a routine they cannot see is a 404, as everywhere.
 */
async function ownRoutine(
  c: Context<AppEnv>,
): Promise<
  | { routine: { id: string; workspace_id: string; trigger_kind: string; name: string } }
  | { refused: Response }
> {
  const { data, error } = await c
    .get("db")
    .from("routines")
    .select("id, workspace_id, trigger_kind, name")
    .eq("id", c.req.param("id") as string)
    .eq("user_id", c.get("user").id)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return { refused: c.json({ error: "invalid routine id" }, 400) };
    return { refused: c.json({ error: "failed to load routine" }, 500) };
  }
  if (!data) return { refused: c.json({ error: "routine not found" }, 404) };
  return {
    routine: data as { id: string; workspace_id: string; trigger_kind: string; name: string },
  };
}

/**
 * What can be listened for, for the create dialog and the routine's page.
 *
 * Only what this deployment can actually do — an entry whose adapter is
 * missing or unconfigured is not offered, so the dialog never shows a choice
 * the engine would refuse. Each entry says whether what it needs is connected
 * in the caller's workspace, so the dialog can offer "Connect Gmail" beside an
 * entry rather than hiding it from somebody who has not connected it yet.
 */
routines.get("/routines/events/catalog", async (c) => {
  const offered = EVENT_REGISTRY.all().filter((def) => canListenFor(EVENT_REGISTRY, c.env, def));
  if (offered.length === 0) return c.json([]);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json([]);
  const connected = await connectedInWorkspace(c.get("db"), workspaceId);
  return c.json(
    offered.map((def) => ({
      type: def.id,
      provider: def.provider,
      app: def.app,
      label: def.label,
      description: def.description,
      fields: def.fields,
      requires: def.requires,
      connected: connected(def.requires),
    })),
  );
});

/**
 * Choose what an event routine waits for, or choose again.
 *
 * Replacing is the only way to change it: the old arrangement is ended at its
 * provider and a new one made, so nothing of a Gmail subscription can leak
 * into a Slack one (`replaceSubscription`). The answer is the routine, with
 * the subscription as the provider left it — `active`, or `failed` with a
 * sentence the page can show.
 *
 * Refused to an API key, and that is the difference from `POST /routines`. A
 * key that creates a routine is written onto it (0088) and revoking the key
 * pauses it; a key that attaches a listener to a routine somebody made in a
 * session leaves something listening after the key is gone.
 */
routines.put("/routines/:id/event", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "choose what a routine listens for");
  if (refusal) return c.json(refusal, 403);

  const parsed = eventChoiceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const own = await ownRoutine(c);
  if ("refused" in own) return own.refused;
  // Refused rather than switched for them, for the webhook route's reason:
  // how a routine starts is a decision about something that runs unattended.
  if (own.routine.trigger_kind !== "event") {
    return c.json({ error: "this routine is not set to start on an event" }, 400);
  }

  const chosen = await chosenEvent(c, own.routine.workspace_id, parsed.data);
  if ("refused" in chosen) return chosen.refused;

  try {
    await replaceSubscription(c.env, own.routine.id, chosen.choice);
  } catch (err) {
    console.error("could not record a routine's event", err);
    return c.json({ error: "could not set up that event" }, 500);
  }

  const { data } = await c
    .get("db")
    .from("routines")
    .select(ROUTINE_SELECT)
    .eq("id", own.routine.id)
    .maybeSingle();
  if (!data) return c.json({ error: "routine not found" }, 404);
  return c.json(mapRoutine(data));
});

/**
 * Stop listening. The routine stays, waiting for nothing until an event is
 * chosen again — the same state as one whose event was never picked, which
 * its page says plainly.
 */
routines.delete("/routines/:id/event", async (c) => {
  const own = await ownRoutine(c);
  if ("refused" in own) return own.refused;
  try {
    await releaseSubscription(c.env, own.routine.id);
  } catch (err) {
    console.error("could not release a routine's event", err);
    return c.json({ error: "failed to stop listening" }, 500);
  }
  return c.body(null, 204);
});

/**
 * What the owner has to paste into the app for the event to arrive, where
 * that is their job rather than ours: a GitHub webhook's URL and secret, for
 * the repository's Settings → Webhooks; the address a routine is mailed at
 * (`email.received`); or, for a Telegram bot, the link a chat opens to pair
 * itself with the routine, and the chats that have. `{ kind: "none" }` for
 * every event this code sets up by itself.
 *
 * The secret leaves the database here and nowhere else
 * (`subscriptionSetup`), so this is the owner's alone, through their own
 * client, and refused to an API key for the reason `PUT /routines/:id/event`
 * gives: a key should not be the way a listener's credentials are carried off.
 */
routines.get("/routines/:id/event/setup", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "read a routine's webhook secret");
  if (refusal) return c.json(refusal, 403);
  const own = await ownRoutine(c);
  if ("refused" in own) return own.refused;

  let setup: Awaited<ReturnType<typeof subscriptionSetup>>;
  try {
    setup = await subscriptionSetup(c.env, own.routine.id);
  } catch (err) {
    console.error("could not read a routine's event setup", err);
    return c.json({ error: "failed to load the setup" }, 500);
  }
  // A routine's own address: no secret, only the address to hand out. The
  // domain is this deployment's; the token is the subscription's.
  const domain = inboundDomain(c.env);
  if (setup?.provider === "email" && setup.externalId && domain) {
    return c.json({
      kind: "email",
      address: agentAddress(domain, own.routine.name, setup.externalId),
    });
  }
  // Telegram: the link a chat opens to pair itself, and which chats have.
  // Never the bot token — `setup.secret` is that, and it stays here.
  if (setup?.provider === "telegram") {
    const botUsername = typeof setup.state.botUsername === "string" ? setup.state.botUsername : "";
    if (!botUsername) return c.json({ kind: "none" });
    const code = await pairingCode(c.env, own.routine.id);
    const chats = Array.isArray(setup.state.chats) ? setup.state.chats : [];
    return c.json({
      kind: "telegram",
      botUsername,
      link: `https://t.me/${botUsername}?start=${code}`,
      code,
      chats: chats
        .map((chat) =>
          chat && typeof chat === "object" ? (chat as { title?: unknown }).title : null,
        )
        .filter((title): title is string => typeof title === "string"),
    });
  }
  if (setup?.provider !== "github" || !setup.externalId || !setup.secret) {
    return c.json({ kind: "none" });
  }
  // This API's own address, as GitHub must call it: the custom domain where
  // there is one, or whatever this request reached.
  const origin = c.env.WORKER_HOST
    ? `https://${c.env.WORKER_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
    : new URL(c.req.url).origin;
  return c.json({
    kind: "github",
    url: `${origin}/routine-events/github/${setup.externalId}`,
    secret: setup.secret,
    contentType: "application/json",
  });
});

/**
 * Run the routine on a made-up event of the kind it waits for — the catalogue
 * entry's `sample` — so its owner can see what it does without waiting for a
 * real mail to arrive.
 *
 * The same road a real event takes (`runPokedRoutine`, `source: "event"`) and
 * the same bill, behind the expensive tier and the same credit check as
 * `POST /routines/:id/run`. Not through `receive.ts`: a test is not counted
 * against the flood guard, and does not need the subscription to be `active`
 * — testing is most useful exactly while the provider is still being set up.
 * Its own delivery key each time, so pressing it twice runs twice.
 */
routines.post("/routines/:id/event/test", async (c) => {
  const { data: routine, error } = await c
    .get("db")
    .from("routines")
    .select(ROUTINE_SELECT)
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load routine" }, 500);
  if (!routine) return c.json({ error: "routine not found" }, 404);
  if (routine.user_id !== c.get("user").id) {
    return c.json({ error: "only the owner can test this routine" }, 403);
  }
  if (routine.trigger_kind !== "event") {
    return c.json({ error: "this routine is not set to start on an event" }, 400);
  }
  const embedded = (Array.isArray(routine.event) ? routine.event[0] : routine.event) as
    { event_type: string } | null | undefined;
  const def = embedded ? EVENT_REGISTRY.eventType(embedded.event_type) : undefined;
  if (!def) return c.json({ error: "choose an event for this routine first" }, 400);

  const denied = await guardCredits(c, routine.workspace_id as string);
  if (denied) return denied;

  const result = await runPokedRoutine(c.env, routine as unknown as RoutineRow, {
    eventId: `test:${crypto.randomUUID()}`,
    payload: def.sample.text,
    source: "event",
    label: `${triggerLabel(def)} (test)`,
  });
  return c.json(result);
});
