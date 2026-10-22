import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { encryptSecret } from "../lib/secret-box";
import { generateSigningSecret } from "../lib/routines/webhook";
import { assertFetchableUrl, ownHostsFrom } from "../lib/routines/url-guard";
import { deliverWebhookNow } from "../lib/webhooks/dispatcher";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { toEpochMs } from "../lib/dto";

/**
 * Webhooks (0131): Settings › API keys, "Signed with a secret you keep" (A26).
 *
 * Every handler works through the caller's own client. The endpoints and the
 * delivery record are their workspace's admins' under 0131's policies, so a
 * member's list is empty and a member's write is refused by the database; the
 * secret is written sealed and no client may read it back, so it is shown
 * once, in the answer that made it. The one thing done outside the caller is
 * the test's send, by the engine, for the one row `enqueue_webhook_test`
 * handed back to an admin.
 */
const webhooks = new Hono<AppEnv>();

export const WEBHOOK_EVENTS = [
  "thread.finished",
  "agent.needs_you",
  "routine.failed",
  "document.created",
] as const;

export type WebhookEndpointDTO = {
  id: string;
  url: string;
  events: Array<(typeof WEBHOOK_EVENTS)[number]>;
  createdBy: string | null;
  createdAt: number;
  enabled: boolean;
};

export type WebhookDeliveryDTO = {
  id: string;
  endpointId: string;
  event: string;
  status: "pending" | "ok" | "failed" | "dropped";
  attempt: number;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

const ENDPOINT_COLUMNS = "id, url, events, created_by, created_at, disabled_at";

function mapEndpoint(row: Record<string, unknown>): WebhookEndpointDTO {
  return {
    id: row.id as string,
    url: row.url as string,
    events: ((row.events as string[] | null) ?? []).filter(
      (e): e is WebhookEndpointDTO["events"][number] =>
        (WEBHOOK_EVENTS as readonly string[]).includes(e),
    ),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: toEpochMs(row.created_at as string),
    enabled: !row.disabled_at,
  };
}

function mapDelivery(row: Record<string, unknown>): WebhookDeliveryDTO {
  const status = row.status as string;
  return {
    id: row.id as string,
    endpointId: row.endpoint_id as string,
    event: row.event as string,
    status: status === "ok" || status === "failed" || status === "dropped" ? status : "pending",
    attempt: Number(row.attempt) || 0,
    statusCode: (row.status_code as number | null) ?? null,
    latencyMs: (row.latency_ms as number | null) ?? null,
    error: (row.last_error as string | null) ?? null,
    createdAt: toEpochMs(row.created_at as string),
    deliveredAt: row.delivered_at ? toEpochMs(row.delivered_at as string) : null,
  };
}

/** A URL the engine will actually send to: https, and not this install or a private address. */
function endpointUrlProblem(raw: string, ownHosts: string[]): string | null {
  let url: URL;
  try {
    url = assertFetchableUrl(raw, ownHosts);
  } catch (err) {
    return err instanceof Error ? err.message : "that is not a usable URL";
  }
  return url.protocol === "https:" ? null : "a webhook must be https";
}

/** The policy said no: not an admin here. */
function refused(error: { code?: string } | null): boolean {
  return error?.code === "42501";
}

// GET /webhooks — the endpoints and the last day of what was sent.
webhooks.get("/webhooks", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no active workspace" }, 400);
  const db = c.get("db");
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [endpoints, deliveries] = await Promise.all([
    db
      .from("webhook_endpoints")
      .select(ENDPOINT_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true }),
    db
      .from("webhook_deliveries")
      .select(
        "id, endpoint_id, event, status, attempt, status_code, latency_ms, last_error, created_at, delivered_at",
      )
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (endpoints.error || deliveries.error) {
    return c.json({ error: "failed to load webhooks" }, 500);
  }
  return c.json({
    events: WEBHOOK_EVENTS,
    endpoints: (endpoints.data ?? []).map(mapEndpoint),
    deliveries: (deliveries.data ?? []).map(mapDelivery),
  });
});

const createSchema = z.object({
  url: z.string().min(1).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).default([]),
});

// POST /webhooks — answers with the signing secret, once.
webhooks.post("/webhooks", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "add a webhook");
  if (refusal) return c.json(refusal, 403);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const problem = endpointUrlProblem(parsed.data.url, ownHostsFrom(c.env));
  if (problem) return c.json({ error: problem }, 400);
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no active workspace" }, 400);

  const secret = generateSigningSecret();
  const { data, error } = await c
    .get("db")
    .from("webhook_endpoints")
    .insert({
      workspace_id: workspaceId,
      url: parsed.data.url,
      events: [...new Set(parsed.data.events)],
      secret_ciphertext: await encryptSecret(secret, c.env.ROUTINE_SECRET_KEY),
      created_by: c.get("user").id,
    })
    .select(ENDPOINT_COLUMNS)
    .single();
  if (error || !data) {
    return refused(error)
      ? c.json({ error: "only admins can add a webhook" }, 403)
      : c.json({ error: "failed to add the webhook" }, 500);
  }
  return c.json({ ...mapEndpoint(data), secret }, 201);
});

const updateSchema = z
  .object({
    url: z.string().min(1).max(2000).optional(),
    events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

// PATCH /webhooks/:id — where it goes, what it hears, whether it is on.
webhooks.patch("/webhooks/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "change a webhook");
  if (refusal) return c.json(refusal, 403);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;
  if (body.url !== undefined) {
    const problem = endpointUrlProblem(body.url, ownHostsFrom(c.env));
    if (problem) return c.json({ error: problem }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.url !== undefined) patch.url = body.url;
  if (body.events !== undefined) patch.events = [...new Set(body.events)];
  if (body.enabled !== undefined)
    patch.disabled_at = body.enabled ? null : new Date().toISOString();

  const { data, error } = await c
    .get("db")
    .from("webhook_endpoints")
    .update(patch)
    .eq("id", c.req.param("id"))
    .select(ENDPOINT_COLUMNS)
    .maybeSingle();
  if (error) return c.json({ error: "failed to update the webhook" }, 500);
  // Not an admin, or not there: the policy answers both with no row.
  if (!data) return c.json({ error: "webhook not found" }, 404);
  return c.json(mapEndpoint(data));
});

webhooks.delete("/webhooks/:id", async (c) => {
  const { data, error } = await c
    .get("db")
    .from("webhook_endpoints")
    .delete()
    .eq("id", c.req.param("id"))
    .select("id");
  if (error) return c.json({ error: "failed to remove the webhook" }, 500);
  if (!data?.length) return c.json({ error: "webhook not found" }, 404);
  return c.body(null, 204);
});

// POST /webhooks/:id/rotate — a new secret, shown once; the old one stops now.
webhooks.post("/webhooks/:id/rotate", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "rotate a webhook's secret");
  if (refusal) return c.json(refusal, 403);
  const secret = generateSigningSecret();
  const { data, error } = await c
    .get("db")
    .from("webhook_endpoints")
    .update({
      secret_ciphertext: await encryptSecret(secret, c.env.ROUTINE_SECRET_KEY),
      updated_at: new Date().toISOString(),
    })
    .eq("id", c.req.param("id"))
    .select(ENDPOINT_COLUMNS)
    .maybeSingle();
  if (error) return c.json({ error: "failed to rotate the secret" }, 500);
  if (!data) return c.json({ error: "webhook not found" }, 404);
  return c.json({ ...mapEndpoint(data), secret });
});

/** `callDeletionFn`'s mapping, for the two functions below. */
function rpcFailure(error: { code?: string; message?: string }): {
  status: 400 | 403 | 404 | 500;
  message: string;
} {
  if (error.code === "42501") return { status: 403, message: error.message ?? "not allowed" };
  if (error.code === "P0002") return { status: 404, message: error.message ?? "not found" };
  if (error.code === "22023") return { status: 400, message: error.message ?? "not possible" };
  return { status: 500, message: "something went wrong" };
}

// POST /webhooks/:id/test — one signed POST now, recorded like any other.
webhooks.post("/webhooks/:id/test", async (c) => {
  const { data: deliveryId, error } = await c
    .get("db")
    .rpc("enqueue_webhook_test", { p_endpoint_id: c.req.param("id") });
  if (error) {
    const failure = rpcFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
  const outcome = await deliverWebhookNow(c.env, deliveryId as string);
  return c.json({ deliveryId, ...(outcome ?? { status: "pending" }) });
});

// POST /webhooks/deliveries/:id/resend — a delivery that gave up, from its first try.
webhooks.post("/webhooks/deliveries/:id/resend", async (c) => {
  const { error } = await c
    .get("db")
    .rpc("resend_webhook_delivery", { p_delivery_id: c.req.param("id") });
  if (error) {
    const failure = rpcFailure(error);
    return c.json({ error: failure.message }, failure.status);
  }
  return c.body(null, 204);
});

export { webhooks };
