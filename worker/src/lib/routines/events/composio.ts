/**
 * The Composio adapter: trigger instances on a person's connected Gmail,
 * Outlook or Google Calendar, delivered to `POST /composio/events`.
 *
 * WHOSE ACCOUNT. The route that recorded the choice found the connection
 * through the caller's own client (`requirements.ts`) and wrote its id into
 * `config.connectionId`. That is the only handle this file accepts. It reads the
 * row again here, with the service role — `connected_account_id` and
 * `composio_user_id` are granted to no client role (0063) — and checks again
 * that it is still the kind of row the routine's owner could have picked:
 * active, in the routine's workspace, and theirs or shared (0098). A
 * connection unshared since, or taken over by someone else's grant, is not
 * subscribed with; it is a sentence on the routine's page.
 *
 * So this is the one adapter that reads the database, and it reads two
 * things: that row, and its own siblings (below). It writes nothing —
 * `lifecycle.ts` still writes every subscription row. That is the reason for
 * its line on `service-client.static.test.ts`'s allowlist.
 *
 * ONE TRIGGER, SEVERAL ROUTINES. Composio's create is an upsert: the same
 * trigger type on the same account with the same settings answers with the
 * instance that already exists. Two routines waiting for "new email in the
 * inbox" on the same Gmail therefore share one `ti_…`, and both rows hold it
 * as `external_id`. Every delivery reaches both (`receive.ts` fans out), and
 * nothing here ends or pauses an instance another row still relies on:
 * `unsubscribe` deletes it only when no other row names it, and `setEnabled`
 * pauses it only when no other row is listening.
 *
 * WHAT A DELIVERY IS CHECKED FOR. The signature is the route's. Here, that the
 * delivery's `connected_account_id` is the account this subscription was made
 * on — recorded in `state` when it was — so a trigger id that somehow pointed
 * at the wrong row could not hand one person's mail to another's routine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import {
  composioConfigured,
  deleteTriggerInstance,
  executeTool,
  setTriggerStatus,
  upsertTriggerInstance,
} from "../../composio/client";
import { entitlementsFor } from "../../entitlements";
import type { AdapterContext, EventAdapter, SubscribeResult } from "./adapter";
import type { NormalizedEvent } from "./catalog";
import { composioSpec, type ToolFetch } from "./composio-catalog";
import { EventSourceError } from "./errors";

/** What `state` holds for a Composio subscription. Never sent to a client. */
type ComposioState = { connectedAccountId?: string; composioUserId?: string };

type Account = { connectedAccountId: string; composioUserId: string };

export type ComposioAdapterDeps = { db?: (env: RoutineEnv) => SupabaseClient };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function composioAdapter(deps: ComposioAdapterDeps = {}): EventAdapter {
  const dbFor = deps.db ?? serviceClient;

  /**
   * The account behind `config.connectionId`, if it is still one the
   * routine's owner may listen through. A refusal is `expired`: no retry
   * reconnects somebody's Google account for them.
   */
  async function accountFor(ctx: AdapterContext): Promise<Account> {
    const app = ctx.eventType.app;
    const gone = new EventSourceError(
      `${app} is no longer connected. Connect it again, then choose this event again.`,
      { expired: true },
    );
    const connectionId = str(ctx.subscription.config?.connectionId);
    if (!connectionId) throw gone;
    const requirement = ctx.eventType.requires;
    const { data, error } = await dbFor(ctx.env)
      .from("tool_connections")
      .select(
        "id, workspace_id, created_by, scope, status, transport, toolkit_slug, " +
          "connected_account_id, composio_user_id",
      )
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw new Error(`could not read the connection: ${error.message}`);
    const row = data as Record<string, unknown> | null;
    if (
      !row ||
      row.workspace_id !== ctx.routine.workspace_id ||
      row.transport !== "composio" ||
      row.status !== "active" ||
      (requirement.kind === "composio" && row.toolkit_slug !== requirement.toolkit) ||
      !(row.scope === "workspace" || row.created_by === ctx.routine.user_id)
    ) {
      throw gone;
    }
    const connectedAccountId = str(row.connected_account_id);
    const composioUserId = str(row.composio_user_id);
    if (!connectedAccountId || !composioUserId) throw gone;
    return { connectedAccountId, composioUserId };
  }

  /** Other rows that hold the same trigger instance — see the module comment. */
  async function siblings(ctx: AdapterContext, onlyListening: boolean): Promise<number> {
    const externalId = ctx.subscription.external_id;
    if (!externalId) return 0;
    let query = dbFor(ctx.env)
      .from("routine_event_subscriptions")
      .select("routine_id")
      .eq("provider", "composio")
      .eq("external_id", externalId)
      .neq("routine_id", ctx.subscription.routine_id);
    if (onlyListening) query = query.eq("status", "active");
    const { data, error } = await query;
    if (error) throw new Error(`could not read the trigger's other routines: ${error.message}`);
    return (data ?? []).length;
  }

  async function subscribe(ctx: AdapterContext): Promise<SubscribeResult> {
    const spec = composioSpec(ctx.eventType.id);
    if (!spec)
      throw new EventSourceError(`This deployment cannot listen for ${ctx.eventType.app}.`);
    const account = await accountFor(ctx);
    const res = await upsertTriggerInstance(ctx.env, {
      slug: spec.slug,
      connectedAccountId: account.connectedAccountId,
      userId: account.composioUserId,
      triggerConfig: spec.triggerConfig(ctx.subscription.config ?? {}),
    });
    if (res.kind === "error") {
      // A 4xx about the request itself (a calendar id that does not exist, a
      // search Gmail refuses) is something the person can fix; say it. The
      // rest — Composio down, our key refused — is ours, and retried.
      if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 401 &&
        res.status !== 403 &&
        res.status !== 429
      ) {
        throw new EventSourceError(
          `${ctx.eventType.app} refused these settings: ${res.message.slice(0, 200)}`,
        );
      }
      throw new Error(`Composio answered ${res.status}: ${res.message}`);
    }
    const state: ComposioState = {
      connectedAccountId: account.connectedAccountId,
      composioUserId: account.composioUserId,
    };
    return { externalId: res.triggerId, state };
  }

  return {
    provider: "composio",

    isConfigured: (env) => composioConfigured(env) && Boolean(env.COMPOSIO_WEBHOOK_SECRET),

    subscribe,

    async unsubscribe(ctx) {
      const id = ctx.subscription.external_id;
      if (!id) return;
      if ((await siblings(ctx, false)) > 0) {
        // Still somebody else's. Paused if none of them is listening, so it
        // does not deliver to nobody.
        if ((await siblings(ctx, true)) === 0) await setTriggerStatus(ctx.env, id, false);
        return;
      }
      const res = await deleteTriggerInstance(ctx.env, id);
      if (res.kind === "error") throw new Error(`Composio answered ${res.status}: ${res.message}`);
    },

    async setEnabled(ctx, enabled) {
      // Resuming is subscribing again: the upsert re-enables the instance it
      // matches, and makes a new one if somebody deleted it at Composio in the
      // meantime — which a plain "enable" would answer with a 404.
      if (enabled) return subscribe(ctx);
      const id = ctx.subscription.external_id;
      if (!id || (await siblings(ctx, true)) > 0) return;
      const res = await setTriggerStatus(ctx.env, id, false);
      if (res.kind === "error" && res.status !== 404 && res.status !== 410) {
        throw new Error(`Composio answered ${res.status}: ${res.message}`);
      }
    },

    async normalize(raw, ctx): Promise<NormalizedEvent | null> {
      const delivery = raw as { metadata?: Record<string, unknown>; data?: unknown } | null;
      const data =
        delivery?.data && typeof delivery.data === "object"
          ? (delivery.data as Record<string, unknown>)
          : null;
      if (!data) return null;

      const state = (ctx.subscription.state ?? {}) as ComposioState;
      const delivered = str(delivery?.metadata?.connected_account_id);
      if (state.connectedAccountId && delivered && delivered !== state.connectedAccountId) {
        console.error(
          `composio delivery for ${ctx.subscription.routine_id} names a different account; dropped`,
        );
        return null;
      }

      const spec = composioSpec(ctx.eventType.id);
      if (!spec) return null;
      const event = await spec.describe(data, toolFetch(ctx, state));
      if (!event) return null;
      // The routine's own mail coming back round: a routine that delivers to
      // the same mailbox it listens to would otherwise answer itself, once per
      // answer, until the flood fuse stopped it.
      if (isOwnDelivery(ctx.env, event)) return null;
      return event;
    },
  };
}

/**
 * How a description fetches what the delivery left out (an Outlook message by
 * its id), on the subscription's own account. Billed to the routine's
 * workspace like any other Composio call (`run_tool`'s reason); a failure is a
 * `null`, never a thrown delivery.
 */
function toolFetch(ctx: AdapterContext, state: ComposioState): ToolFetch {
  return async (slug, args) => {
    if (!state.connectedAccountId || !state.composioUserId) return null;
    const res = await executeTool(ctx.env, {
      slug,
      connectedAccountId: state.connectedAccountId,
      userId: state.composioUserId,
      arguments: args,
    });
    if (res.kind === "ok" || (res.status !== 501 && res.status !== 502)) {
      await entitlementsFor(ctx.env)
        .record(ctx.routine.workspace_id, [{ kind: "composio_call", toolSlug: slug }], {
          userId: ctx.routine.user_id,
        })
        .catch((err: unknown) => console.error("failed to record an event lookup", err));
    }
    if (res.kind === "error") {
      console.error(`event lookup ${slug} failed: ${res.status} ${res.message.slice(0, 300)}`);
      return null;
    }
    return res.body;
  };
}

/** Whether this mail was sent by this deployment's routine sender. */
function isOwnDelivery(env: RoutineEnv, event: NormalizedEvent): boolean {
  const sender = (event.fields?.sender ?? "").toLowerCase();
  const from = (env.RESEND_FROM ?? "").toLowerCase();
  if (!sender || !from) return false;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  return Boolean(address) && sender.includes(address);
}

export const COMPOSIO_ADAPTER = composioAdapter();

/**
 * End a trigger instance nothing here is waiting for — a delivery whose
 * `trigger_id` matches no row (`receive.ts`'s `unknown`). Typically a routine
 * deleted while Composio could not be reached, whose instance kept polling.
 *
 * The one case where that would be wrong: a subscribe in flight. Its instance
 * exists at Composio a moment before its id is written here, and on a pushed
 * trigger a delivery can land in that moment. So nothing is cancelled while
 * any Composio subscription is `pending` — that state lasts the length of
 * one upsert, and a real orphan will deliver again.
 */
export async function cancelOrphanTrigger(
  env: RoutineEnv,
  triggerId: string,
  deps: { db?: SupabaseClient } = {},
): Promise<void> {
  if (!composioConfigured(env) || !/^[A-Za-z0-9_-]{1,128}$/.test(triggerId)) return;
  const db = deps.db ?? serviceClient(env);
  const { data, error } = await db
    .from("routine_event_subscriptions")
    .select("routine_id")
    .eq("provider", "composio")
    .or(`external_id.eq.${triggerId},status.eq.pending`)
    .limit(1);
  if (error || (data ?? []).length > 0) return;
  const res = await deleteTriggerInstance(env, triggerId);
  if (res.kind === "error") {
    console.error(`could not cancel orphaned trigger ${triggerId}: ${res.status} ${res.message}`);
  }
}
