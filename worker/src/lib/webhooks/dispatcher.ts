import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { decryptSecret } from "../secret-box";
import { assertFetchableUrl, ownHostsFrom } from "../routines/url-guard";
import { pinnedRequest, resolvesPublicly } from "../routines/source";
import { PAYLOAD_VERSION, signWebhookBody, webhookHeaders } from "../routines/webhook";

/**
 * Sends what `webhook_deliveries` holds (0131): the workspace's own events,
 * signed, to the endpoints its admins named.
 *
 * Each row is tried at once, then five, fifteen and forty minutes after the
 * try before — four tries over about an hour, "retried three times over an
 * hour, then dropped and listed below" (A26) — and then it is `failed`, with
 * a Resend beside it. An endpoint turned off before a row's turn makes that
 * row `dropped`.
 *
 * Signed exactly as a routine's webhook channel is (`lib/routines/webhook.ts`):
 * `X-Covan-Signature: v1=<hmac>` over `v1:<timestamp>:<body>`, so one verifier
 * serves both. The host is checked against the network on every try, for the
 * reason `resolvesPublicly` gives: public when it was saved is not public now.
 */

/** Minutes to wait after each failed try before the next. */
export const RETRY_AFTER_MINUTES = [5, 15, 40] as const;
export const MAX_ATTEMPTS = RETRY_AFTER_MINUTES.length + 1;
export const SEND_TIMEOUT_MS = 10_000;
/** Bounded so the stage never takes the tick from the routines after it. */
export const DELIVERIES_PER_TICK = 5;
const MAX_ERROR = 300;

export type DueDelivery = {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event: string;
  payload: unknown;
  attempt: number;
  created_at: string;
  url: string;
  secret_ciphertext: string;
  disabled_at: string | null;
};

export type WebhookDeps = {
  db: SupabaseClient;
  fetchImpl: typeof fetch;
  secretKey: string;
  ownHosts: string[];
  now: () => Date;
};

export type SendOutcome = {
  status: "ok" | "pending" | "failed" | "dropped";
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
};

export function webhookDepsFrom(env: RoutineEnv, db?: SupabaseClient): WebhookDeps {
  return {
    db: db ?? serviceClient(env),
    // Bound for the reason `executorDeps` gives: Workers refuses an unbound fetch.
    fetchImpl: fetch.bind(globalThis),
    secretKey: env.ROUTINE_SECRET_KEY,
    ownHosts: ownHostsFrom(env),
    now: () => new Date(),
  };
}

/** The body a receiver gets: the event, when it happened, and its ids and labels. */
export function webhookBody(delivery: DueDelivery, sentAt: Date): string {
  return JSON.stringify({
    version: PAYLOAD_VERSION,
    id: delivery.id,
    event: delivery.event,
    createdAt: delivery.created_at,
    sentAt: sentAt.toISOString(),
    workspaceId: delivery.workspace_id,
    data: delivery.payload ?? {},
  });
}

/** One try at one row, and the row written with how it went. Never throws. */
export async function sendDelivery(delivery: DueDelivery, deps: WebhookDeps): Promise<SendOutcome> {
  const attempt = delivery.attempt + 1;
  const outcome = delivery.disabled_at
    ? {
        status: "dropped" as const,
        statusCode: null,
        latencyMs: null,
        error: "the endpoint is off",
      }
    : await post(delivery, deps, attempt);

  const now = deps.now();
  const { error } = await deps.db
    .from("webhook_deliveries")
    .update({
      status: outcome.status,
      attempt: outcome.status === "dropped" ? delivery.attempt : attempt,
      status_code: outcome.statusCode,
      latency_ms: outcome.latencyMs,
      last_error: outcome.error,
      claimed_at: null,
      delivered_at: outcome.status === "ok" ? now.toISOString() : null,
      ...(outcome.status === "pending"
        ? {
            next_attempt_at: new Date(
              now.getTime() + RETRY_AFTER_MINUTES[attempt - 1]! * 60_000,
            ).toISOString(),
          }
        : {}),
    })
    .eq("id", delivery.id);
  if (error) console.error("webhooks: could not record a try", delivery.id, error.code);
  return outcome;
}

async function post(
  delivery: DueDelivery,
  deps: WebhookDeps,
  attempt: number,
): Promise<SendOutcome> {
  const retryOrGiveUp = attempt >= MAX_ATTEMPTS ? ("failed" as const) : ("pending" as const);
  const started = Date.now();
  try {
    const url = assertFetchableUrl(delivery.url, deps.ownHosts);
    const address = await resolvesPublicly(url.hostname);
    const secret = await decryptSecret(delivery.secret_ciphertext, deps.secretKey);
    const sentAt = deps.now();
    const timestampSeconds = Math.floor(sentAt.getTime() / 1000);
    const body = webhookBody(delivery, sentAt);
    const signature = await signWebhookBody(secret, timestampSeconds, body);
    const res = await deps.fetchImpl(
      ...pinnedRequest(url, address, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...webhookHeaders({
            event: delivery.event,
            deliveryId: delivery.id,
            timestampSeconds,
            signature,
          }),
          "User-Agent": "covan-webhooks/1.0",
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    );
    const latencyMs = Date.now() - started;
    if (res.ok) return { status: "ok", statusCode: res.status, latencyMs, error: null };
    const text = await res.text().catch(() => "");
    return {
      status: retryOrGiveUp,
      statusCode: res.status,
      latencyMs,
      error:
        res.status >= 300 && res.status < 400
          ? `answered ${res.status}: a signed POST is not followed — use the final URL`
          : `answered ${res.status}${text ? `: ${text.slice(0, MAX_ERROR)}` : ""}`,
    };
  } catch (err) {
    return {
      status: retryOrGiveUp,
      statusCode: null,
      latencyMs: Date.now() - started,
      error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR),
    };
  }
}

/**
 * The background stage: up to `DELIVERIES_PER_TICK` due rows, one after
 * another. Returns how many it claimed, which is all the tick needs to know.
 */
export async function dispatchWebhooks(
  env: RoutineEnv,
  overrides: Partial<WebhookDeps> = {},
): Promise<{ claimed: number; delivered: number }> {
  const deps = { ...webhookDepsFrom(env, overrides.db), ...overrides };
  const { data, error } = await deps.db.rpc("claim_due_webhook_deliveries", {
    p_limit: DELIVERIES_PER_TICK,
  });
  if (error) {
    console.error("webhooks: could not claim deliveries", error.code);
    return { claimed: 0, delivered: 0 };
  }
  const due = (data ?? []) as DueDelivery[];
  let delivered = 0;
  for (const delivery of due) {
    if ((await sendDelivery(delivery, deps)).status === "ok") delivered++;
  }
  return { claimed: due.length, delivered };
}

/**
 * Sends one row now — the test an admin asked for. Bounded to the one id the
 * route's own `enqueue_webhook_test` returned, which that function only
 * returns to an admin of the endpoint's workspace.
 */
export async function deliverWebhookNow(
  env: RoutineEnv,
  deliveryId: string,
  overrides: Partial<WebhookDeps> = {},
): Promise<SendOutcome | null> {
  const deps = { ...webhookDepsFrom(env, overrides.db), ...overrides };
  // Claimed as the tick claims, so a tick that runs meanwhile does not send
  // it a second time.
  const { data, error } = await deps.db
    .from("webhook_deliveries")
    .update({ claimed_at: deps.now().toISOString() })
    .eq("id", deliveryId)
    .eq("status", "pending")
    .is("claimed_at", null)
    .select(
      "id, endpoint_id, workspace_id, event, payload, attempt, created_at, endpoint:webhook_endpoints(url, secret_ciphertext, disabled_at)",
    )
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Omit<DueDelivery, "url" | "secret_ciphertext" | "disabled_at"> & {
    endpoint: Pick<DueDelivery, "url" | "secret_ciphertext" | "disabled_at"> | null;
  };
  if (!row.endpoint) return null;
  const { endpoint, ...rest } = row;
  return sendDelivery({ ...rest, ...endpoint }, deps);
}
