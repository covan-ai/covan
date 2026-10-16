/**
 * Slack: a message in a channel, or a reaction to one, starting a routine.
 *
 * THE SAME APP, A SECOND LISTENER. Slack already delivers everything the
 * installed app hears to `POST /slack/events`, where `lib/slack/handle.ts`
 * answers mentions and direct messages. A routine that waits for Slack
 * activity is not a second app or a second subscription at Slack: it is a
 * second reader of the same deliveries. So nothing here talks to Slack to
 * subscribe — `subscribe` only checks that the install can hear what the
 * routine asks for and records which channel that is — and the route hands
 * each delivery to `deliverSlackEvent` (`slack-deliver.ts`) beside the answer
 * flow, which it never changes. A routine never answers in Slack; it delivers
 * wherever its own delivery channel says.
 *
 * FINDING WHO IS WAITING. Every routine listening to one Slack workspace holds
 * that workspace's team id as its `external_id`, and a delivery names its
 * team. `receive.ts` could look those rows up by provider and id, but it reads
 * at most 25 of them (`MAX_FAN_OUT`), and a busy workspace can easily have
 * more Slack routines than that — most of them about other channels. So the
 * lookup is narrowed here first, in one indexed read: this team, this kind of
 * event, rows still `active`, and either this channel or no channel at all.
 * Each match is then handed to `receiveEvent` by its routine id, which
 * re-reads it and applies everything every other provider's events go
 * through: the routine still running, the filters, the flood fuse, the run.
 *
 * WHAT IS NEVER A TRIGGER. The app's own messages and any bot's (`bot_id`); a
 * message that is about a message rather than one (`message_changed`,
 * `message_deleted`, joins — every subtype except a file share and a thread
 * reply also sent to the channel); a reaction added by the app. A routine that
 * reported into a Slack channel it also listened to would otherwise be told
 * about its own report and run again, forever.
 *
 * WHAT IT COSTS SLACK. A delivery nobody waits for costs one indexed read and
 * no Slack call. One somebody waits for costs up to three, made once however
 * many routines are waiting: who wrote it, a link to it, and for a reaction
 * what the message said — a reaction event names the message, not its text.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../../supabase";
import { decryptSecret } from "../../secret-box";
import { findChannel } from "../../slack/api";
import type { SlackEvent } from "../../slack/handle";
import { SCOPES_FOR_EVENTS, missingScopes } from "../../slack/scopes";
import type { EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef, NormalizedEvent } from "./catalog";
import { EventSourceError } from "./errors";
import { clip, lines, rec, str } from "./text";

/** A Slack id: channels, users, teams. Letters and digits, nothing else. */
export const SLACK_ID = /^[A-Z0-9]{2,32}$/;

/** At most this many routines are started by one Slack event. */
export const MAX_SLACK_LISTENERS = 50;

/**
 * What `deliverSlackEvent` hands each waiting routine: the event, already
 * read and with the few facts Slack had to be asked for filled in once.
 */
export type SlackDelivery = {
  kind: "message" | "reaction";
  /** Slack's id for the delivery (`event_id`), or one made from the message. */
  eventId: string;
  teamId: string;
  channel: string;
  channelName: string | null;
  /** Who wrote the message, or who reacted. */
  user: string;
  userName: string | null;
  /** The message's text — for a reaction, the text of the message reacted to. */
  text: string;
  ts: string;
  permalink: string | null;
  /** A reaction's emoji, without colons. */
  reaction?: string;
  /** A reaction: who wrote the message that was reacted to. */
  author?: string | null;
};

const MESSAGE_SUBTYPES_THAT_ARE_MESSAGES = new Set(["file_share", "thread_broadcast"]);

/** What kind of trigger this event could be, or null when it is none. */
export function classifySlackEvent(
  event: SlackEvent,
  botUserId: string,
): { kind: "message" | "reaction"; channel: string; user: string; ts: string } | null {
  if (event.bot_id || !event.user || event.user === botUserId) return null;

  if (event.type === "message") {
    if (event.channel_type !== "channel" && event.channel_type !== "group") return null;
    if (event.subtype && !MESSAGE_SUBTYPES_THAT_ARE_MESSAGES.has(event.subtype)) return null;
    if (!event.channel || !event.ts || !event.text?.trim()) return null;
    return { kind: "message", channel: event.channel, user: event.user, ts: event.ts };
  }

  if (event.type === "reaction_added") {
    const item = event.item;
    if (!event.reaction || item?.type !== "message" || !item.channel || !item.ts) return null;
    return { kind: "reaction", channel: item.channel, user: event.user, ts: item.ts };
  }

  return null;
}

/**
 * Slack's markup, made readable: `<#C123|general>` is `#general`, `<url|label>`
 * is `label (url)`, `<url>` is the url. A user mention `<@U123>` is left as it
 * is — resolving every one is a call per name, and the model reads it fine.
 */
export function readableSlackText(text: string): string {
  return text
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `:+1::skin-tone-2:`, `+1::skin-tone-2` and `+1` are all the same reaction. */
export function emojiName(value: string): string {
  return value.trim().replace(/^:|:$/g, "").split("::")[0].toLowerCase();
}

// ---- config ---------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const CHANNEL_HELP =
  "A channel name like #support, or a channel ID from the channel's details. The Covan app has to be in the channel: type /invite @Covan there.";

const messageConfig = z.object({
  channel: z.string().trim().min(1).max(100),
  contains: optionalText(200),
  from: optionalText(100),
});

const reactionConfig = z.object({
  emoji: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((v) => emojiName(v)),
  channel: optionalText(100),
});

const REQUIRES = { kind: "slack" } as const;

// ---- the entries ------------------------------------------------------------------

export const SLACK_EVENTS: readonly EventTypeDef[] = [
  {
    id: "slack.new_message",
    provider: "slack",
    app: "Slack",
    label: "New message in a channel",
    description: "Runs when somebody writes in a Slack channel the Covan app is in.",
    requires: REQUIRES,
    config: messageConfig,
    fields: [
      {
        key: "channel",
        label: "Channel",
        kind: "text",
        placeholder: "#support",
        help: CHANNEL_HELP,
      },
      {
        key: "contains",
        label: "Only messages containing",
        kind: "text",
        optional: true,
        placeholder: "invoice",
        help: "Leave empty for every message in the channel.",
      },
      {
        key: "from",
        label: "Only from",
        kind: "text",
        optional: true,
        placeholder: "Ayşe Demir",
        help: "A name as Slack shows it, or a member ID.",
        advanced: true,
      },
    ],
    matches: (config, event) => {
      const contains = str(config.contains).toLowerCase();
      if (contains && !(event.fields?.text ?? "").toLowerCase().includes(contains)) return false;
      const from = str(config.from).replace(/^@/, "").toLowerCase();
      if (!from) return true;
      return (
        (event.fields?.user ?? "").toLowerCase() === from ||
        (event.fields?.userName ?? "").toLowerCase() === from
      );
    },
    sample: {
      eventId: "sample",
      text:
        lines([
          ["Channel", "#support"],
          ["From", "Ayşe Demir"],
        ]) + "\n\nThe export button on the billing page returns an empty file since this morning.",
      fields: {
        text: "The export button on the billing page returns an empty file since this morning.",
      },
    },
  },
  {
    id: "slack.reaction_added",
    provider: "slack",
    app: "Slack",
    label: "Reaction added",
    description: "Runs when somebody reacts to a message with a particular emoji.",
    requires: REQUIRES,
    config: reactionConfig,
    fields: [
      {
        key: "emoji",
        label: "Emoji",
        kind: "text",
        placeholder: "eyes",
        help: "The emoji's name, with or without colons: eyes, :white_check_mark:.",
      },
      {
        key: "channel",
        label: "Only in",
        kind: "text",
        optional: true,
        placeholder: "#support",
        help: "Leave empty for every channel the Covan app is in.",
      },
    ],
    matches: (config, event) => emojiName(str(config.emoji)) === (event.fields?.reaction ?? ""),
    sample: {
      eventId: "sample",
      text:
        lines([
          ["Reaction", ":eyes:"],
          ["By", "Mert Kaya"],
          ["Channel", "#support"],
          ["Message by", "Ayşe Demir"],
        ]) + "\n\nCan someone look at the failed payment for order 4417?",
      fields: { reaction: "eyes" },
    },
  },
];

export const EVENT_TYPE_OF = {
  message: "slack.new_message",
  reaction: "slack.reaction_added",
} as const;

// ---- the adapter -----------------------------------------------------------------------

type InstallRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  scopes: string[] | null;
  secret_ciphertext: string;
};

export type SlackAdapterDeps = { db?: SupabaseClient; fetchImpl?: typeof fetch };

export function slackAdapter(deps: SlackAdapterDeps = {}): EventAdapter {
  return {
    provider: "slack",
    // Not `SLACK_CLIENT_ID` and friends, on purpose. Those live on the API
    // Worker only, and the cron Worker syncs subscriptions too (the sweeper,
    // a flood pause): an adapter it called unconfigured would mark every Slack
    // routine failed the first time it looked. What a subscription needs is an
    // installation, which `requires: slack` already asks for, and the key its
    // token is sealed with.
    isConfigured: (env) => Boolean(env.ROUTINE_SECRET_KEY),

    async subscribe(ctx): Promise<SubscribeResult> {
      const gone = new EventSourceError(
        "Slack is no longer connected to this workspace. Connect it again, then choose this event again.",
        { expired: true },
      );
      const installationId = str(ctx.subscription.config?.connectionId);
      if (!installationId) throw gone;

      // The service role, because the token is a column no client may read
      // (0044). Keyed to the installation the route found through the caller's
      // own client, and re-checked against the routine's own workspace.
      const db = deps.db ?? serviceClient(ctx.env);
      const { data, error } = await db
        .from("slack_installations")
        .select("id, workspace_id, team_id, scopes, secret_ciphertext")
        .eq("id", installationId)
        .maybeSingle();
      if (error) throw new Error(`could not read the Slack installation: ${error.message}`);
      const install = data as InstallRow | null;
      if (!install || install.workspace_id !== ctx.routine.workspace_id) throw gone;

      const kind = ctx.eventType.id === "slack.reaction_added" ? "reaction" : "message";
      if (missingScopes(install.scopes, SCOPES_FOR_EVENTS[kind]).length > 0) {
        throw new EventSourceError(
          "Slack was connected before Covan could hear channel activity. Reconnect Slack from the Integrations page, then choose this event again.",
        );
      }

      const named = str(ctx.subscription.config?.channel);
      if (!named) return { externalId: install.team_id, state: { teamId: install.team_id } };

      const token = await decryptSecret(install.secret_ciphertext, ctx.env.ROUTINE_SECRET_KEY);
      const channel = await findChannel(deps.fetchImpl ?? fetch, token, named);
      if (!channel) {
        throw new EventSourceError(
          `Couldn't find ${named.startsWith("#") ? named : `#${named}`} in Slack. For a private channel, paste its channel ID from the channel's details.`,
        );
      }
      if (channel.isMember === false) {
        throw new EventSourceError(
          `The Covan app isn't in #${channel.name} yet. Type /invite @Covan in the channel, then choose this event again.`,
        );
      }
      return {
        externalId: install.team_id,
        state: { teamId: install.team_id, channelId: channel.id, channelName: channel.name },
      };
    },

    // Nothing at Slack is ours to end or pause: the app keeps hearing the
    // channel for its other readers, and a delivery to a paused or removed
    // routine is refused in `receive.ts`.
    async unsubscribe() {},
    async setEnabled() {},

    async normalize(raw, ctx): Promise<NormalizedEvent | null> {
      const d = rec(raw) as SlackDelivery | null;
      if (!d || typeof d.channel !== "string") return null;
      const wantKind = ctx.eventType.id === "slack.reaction_added" ? "reaction" : "message";
      if (d.kind !== wantKind) return null;
      // Narrowed in `deliverSlackEvent` already; checked again here because this
      // is what the routine was set up for, and the row is the authority.
      const channelId = str(rec(ctx.subscription.state)?.channelId);
      if (channelId && channelId !== d.channel) return null;

      const channel = d.channelName ? `#${d.channelName}` : `<#${d.channel}>`;
      const who = d.userName ?? `<@${d.user}>`;
      const text = readableSlackText(d.text);
      const fields = {
        text,
        user: d.user,
        userName: d.userName ?? "",
        reaction: d.reaction ?? "",
        channel: d.channel,
      };

      if (d.kind === "reaction") {
        const header = lines([
          ["Reaction", `:${d.reaction}:`],
          ["By", who],
          ["Channel", channel],
          ["Message by", d.author ?? ""],
          ["Link", d.permalink ?? ""],
        ]);
        return {
          eventId: d.eventId,
          text: text ? `${header}\n\n${clip(text)}` : header,
          label: `Slack · :${d.reaction}: in ${channel}`.slice(0, 120),
          fields,
        };
      }

      const header = lines([
        ["Channel", channel],
        ["From", who],
        ["Link", d.permalink ?? ""],
      ]);
      return {
        eventId: d.eventId,
        text: `${header}\n\n${clip(text)}`,
        label: `Slack · New message in ${channel}`.slice(0, 120),
        fields,
      };
    },
  };
}

export const SLACK_ADAPTER = slackAdapter();
