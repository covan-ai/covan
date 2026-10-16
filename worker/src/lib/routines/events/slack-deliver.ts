/**
 * One Slack event, handed to every routine waiting for it.
 *
 * The other half of `slack.ts`, in a file of its own because it calls
 * `receiveEvent` — and `receive.ts` imports the adapter registry, which
 * imports `slack.ts`. Kept apart, the catalogue never pulls in the receiving
 * code, and `POST /slack/events` is the one importer of this.
 *
 * See `slack.ts` for why the waiting routines are found here, narrowed to this
 * team, event and channel, rather than by `receive.ts`'s own lookup.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { decryptSecret } from "../../secret-box";
import { displayName, messageText, permalink } from "../../slack/api";
import type { InstallationRow, SlackEvent } from "../../slack/handle";
import { receiveEvent, type ReceiveDeps } from "./receive";
import {
  EVENT_TYPE_OF,
  MAX_SLACK_LISTENERS,
  SLACK_ID,
  classifySlackEvent,
  emojiName,
  type SlackDelivery,
} from "./slack";
import { rec, str } from "./text";

export type DeliverDeps = Pick<ReceiveDeps, "defer" | "run"> & {
  db: SupabaseClient;
  fetchImpl: typeof fetch;
  /** Injected so a test can see who would have been handed what. */
  receive?: typeof receiveEvent;
};

/**
 * Hand one Slack event to the routines waiting for it. Called by
 * `POST /slack/events` beside the answer flow, after the signature and the
 * team's rate have been checked, with the installation that team resolves to.
 * Never answers in Slack.
 */
export async function deliverSlackEvent(
  env: RoutineEnv,
  installation: InstallationRow,
  event: SlackEvent,
  slackEventId: string,
  deps: DeliverDeps,
): Promise<void> {
  const what = classifySlackEvent(event, installation.bot_user_id);
  // Checked for shape as well as presence: the channel goes into a PostgREST
  // filter below, and a Slack id is letters and digits and nothing else.
  if (!what || !SLACK_ID.test(what.channel) || !SLACK_ID.test(installation.team_id)) return;

  const { data, error } = await deps.db
    .from("routine_event_subscriptions")
    .select("routine_id, state")
    .eq("provider", "slack")
    .eq("external_id", installation.team_id)
    .eq("event_type", EVENT_TYPE_OF[what.kind])
    .eq("status", "active")
    .or(`state->>channelId.eq.${what.channel},state->>channelId.is.null`)
    .limit(MAX_SLACK_LISTENERS);
  if (error) throw new Error(`could not read the Slack subscriptions: ${error.message}`);
  const waiting = (data ?? []) as Array<{
    routine_id: string;
    state: Record<string, unknown> | null;
  }>;
  if (waiting.length === 0) return;

  // The few facts Slack has to be asked for, asked once for everyone waiting.
  const token = await decryptSecret(installation.secret_ciphertext, env.ROUTINE_SECRET_KEY);
  const channelName = waiting.map((w) => str(rec(w.state)?.channelName)).find(Boolean) || null;
  const [userName, link, reacted] = await Promise.all([
    displayName(deps.fetchImpl, token, what.user),
    permalink(deps.fetchImpl, token, what.channel, what.ts),
    what.kind === "reaction"
      ? messageText(deps.fetchImpl, token, what.channel, what.ts)
      : Promise.resolve(null),
  ]);
  const authorId = what.kind === "reaction" ? (event.item_user ?? reacted?.user ?? null) : null;
  const author = authorId ? await displayName(deps.fetchImpl, token, authorId) : null;

  const delivery: SlackDelivery = {
    kind: what.kind,
    eventId:
      slackEventId ||
      `${what.kind}:${what.channel}:${what.ts}:${event.reaction ?? ""}:${what.user}`,
    teamId: installation.team_id,
    channel: what.channel,
    channelName,
    user: what.user,
    userName,
    text: what.kind === "reaction" ? (reacted?.text ?? "") : (event.text ?? ""),
    ts: what.ts,
    permalink: link,
    ...(what.kind === "reaction" ? { reaction: emojiName(event.reaction ?? ""), author } : {}),
  };

  const receive = deps.receive ?? receiveEvent;
  for (const { routine_id } of waiting) {
    try {
      await receive(env, { routineId: routine_id }, delivery, {
        db: deps.db,
        defer: deps.defer,
        run: deps.run,
      });
    } catch (err) {
      // One routine's failure must not keep the event from the others.
      console.error(`slack event for routine ${routine_id} failed`, err);
    }
  }
}
