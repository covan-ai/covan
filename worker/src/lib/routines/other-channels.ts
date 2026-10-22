import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import {
  CONFIRMABLE_COLUMNS,
  readyForDelivery,
  type ConfirmableChannel,
} from "./address-confirmation";
import { deliver, type DeliveryContext, type DeliveryDeps } from "./delivery";

/**
 * The rest of a routine's destinations (0130), after its primary.
 *
 * A routine delivers to `delivery_channel_id` first, and that send is the
 * run's: when it fails, the run fails, as it always has. The channels listed
 * in `routine_channels` come after, and each is best-effort — the result has
 * already arrived where it was first meant to, and failing the run now would
 * retry it and send the primary a second copy. What could not be reached is
 * returned as one sentence for `routine_runs.delivery_note`.
 *
 * The sentence names the kind of destination, never its address or label:
 * the note is on the run, which everybody who can see a shared routine can
 * read, and a channel is its owner's to read (0019).
 *
 * SCOPING: called with the service role, so the channels are checked against
 * the routine's owner here, the way `loadDeliveryChannel` checks the primary.
 */
export async function deliverToOtherChannels(
  env: RoutineEnv,
  db: SupabaseClient,
  routine: { id: string; user_id: string; delivery_channel_id: string },
  message: { subject: string; body: string },
  deliveryDeps: DeliveryDeps,
  context: DeliveryContext,
): Promise<string | undefined> {
  const { data, error } = await db
    .from("routine_channels")
    .select(`delivery_channel_id, channel:delivery_channels(${CONFIRMABLE_COLUMNS}, disabled_at)`)
    .eq("routine_id", routine.id);
  if (error) {
    console.error("routine: could not read its other channels", error.code);
    return "Not sent to the routine's other channels: they could not be read";
  }

  const missed: string[] = [];
  for (const row of (data ?? []) as Array<{ channel: unknown }>) {
    const channel = (Array.isArray(row.channel) ? row.channel[0] : row.channel) as
      (ConfirmableChannel & { disabled_at: string | null }) | null;
    if (!channel || channel.id === routine.delivery_channel_id) continue;
    if (channel.user_id !== routine.user_id || channel.disabled_at) continue;
    try {
      await deliver(await readyForDelivery(env, channel), message, deliveryDeps, context);
    } catch (err) {
      missed.push(
        `${kindWords(channel.kind)} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return missed.length > 0 ? `Not sent to ${missed.join("; ")}` : undefined;
}

function kindWords(kind: string): string {
  return kind === "email"
    ? "an email address"
    : kind === "slack_webhook"
      ? "a Slack channel"
      : "a webhook";
}
