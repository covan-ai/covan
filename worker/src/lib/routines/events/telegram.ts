/**
 * Telegram: a message to your own bot starting a routine, and the routine's
 * report answered in the same chat.
 *
 * THE PERSON'S OWN BOT. Telegram has no "connect your account" for this; a
 * bot is made in a minute by talking to @BotFather, and it hands back a token
 * that is the whole credential. So the person pastes that token with the
 * event (a `secret` field — see `parseEventChoice` for why it never touches
 * `config`), it is sealed into `secret_ciphertext`, and the adapter points the
 * bot's webhook at this API with `setWebhook`.
 *
 * ONE BOT, ONE WEBHOOK, PERHAPS SEVERAL ROUTINES. A bot sends every update to
 * exactly one URL. Two routines given the same bot would otherwise take the
 * webhook from each other, so the URL is the bot's, not the routine's —
 * `/routine-events/telegram/tg_<bot id>`, which is `external_id` — and every
 * routine holding that id is offered each update (`receive.ts` fans out). The
 * webhook is deleted only when the last of them lets go.
 *
 * WHO MAY START IT. Anybody can find a bot and message it. So nothing runs
 * until a chat has paired itself with the routine: the routine's page shows a
 * link, `t.me/<bot>?start=<code>`, and opening it sends `/start <code>` from
 * that chat. The code is an HMAC of the routine's id under
 * `ROUTINE_SECRET_KEY` (`pairingCode`), so it is checked without being stored
 * and is different for every routine on the same bot; a paired chat is kept
 * in the row's `state` (`handshake`). Messages from any other chat are
 * dropped before they cost anything.
 *
 * THE SIGNATURE. `setWebhook` takes a `secret_token` that Telegram sends back
 * on every delivery as `X-Telegram-Bot-Api-Secret-Token`. It is an HMAC of the
 * webhook's id (`webhookToken`), so the route checks it before it reads a
 * single row — the shape of the Composio door, not the GitHub one — and a
 * delivery for a bot nothing here listens to any more can be told apart from
 * a forged one: the first carries our token and is answered 200, so Telegram
 * stops retrying; only the second is counted against the sender.
 *
 * ANSWERING. The run's report goes to the routine's delivery channel as for
 * every routine, and back to the chat the message came from as well:
 * `normalize` puts the chat on the event (`replyTo`), the trigger carries it
 * through the run, and `poke-room.ts` calls `replyToTelegram` once the run is
 * done.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import { decryptSecret } from "../../secret-box";
import { hmacSha256Hex } from "../../hmac";
import type { EventReplyTo, RunResult } from "../executor";
import type { AdapterContext, EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef } from "./catalog";
import { EventSourceError } from "./errors";
import { clip, lines, rec, str } from "./text";

/** What the receiving route hands over, once the secret header has checked out. */
export type TelegramDelivery = { body: string };

/** The shape of the id in a Telegram webhook URL. The route refuses anything else. */
export const TELEGRAM_HOOK_ID = /^tg_\d{1,20}$/;

/** What @BotFather hands out: the bot's numeric id, a colon, the secret half. */
const BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/;

const TELEGRAM_API = "https://api.telegram.org";

/** Telegram refuses a message longer than this. */
const MAX_MESSAGE_CHARS = 4_000;

/** How many chats one routine can be paired with. Enough for a team, not a broadcast. */
const MAX_CHATS = 20;

// ---- the two derived secrets ------------------------------------------------------

/**
 * The `secret_token` a bot's webhook is set with, and what the route expects
 * back. An HMAC of the webhook's id, so it is the same for every routine on
 * one bot (they share the webhook) and needs no column. Hex is inside the
 * characters Telegram allows (`A-Za-z0-9_-`, at most 256).
 */
export async function webhookToken(env: RoutineEnv, externalId: string): Promise<string> {
  return hmacSha256Hex(env.ROUTINE_SECRET_KEY, `covan/telegram-webhook/v1\n${externalId}`);
}

/**
 * The code a chat sends as `/start <code>` to pair with one routine. Per
 * routine, so pairing with one of two routines on the same bot pairs with
 * that one only. 24 hex characters: inside a deep link's 64, and not
 * something anybody guesses.
 */
export async function pairingCode(env: RoutineEnv, routineId: string): Promise<string> {
  return (
    await hmacSha256Hex(env.ROUTINE_SECRET_KEY, `covan/telegram-pair/v1\n${routineId}`)
  ).slice(0, 24);
}

// ---- the bot API -------------------------------------------------------------------

export type TelegramDeps = { fetchImpl?: typeof fetch; db?: (env: RoutineEnv) => SupabaseClient };

type Answer = { ok: true; result: unknown } | { ok: false; status: number; description: string };

/**
 * One Bot API call. The token is in the URL — that is how Telegram's API is
 * addressed — so nothing here may put the URL into an error or a log line;
 * what comes back says only the method and what Telegram answered.
 */
async function callBot(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  deps: TelegramDeps,
): Promise<Answer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 0, description: `${method} could not reach Telegram` };
  }
  const body = rec(await res.json().catch(() => null));
  if (res.ok && body?.ok === true) return { ok: true, result: body.result };
  return {
    ok: false,
    status: res.status,
    description: str(body?.description).slice(0, 200) || `${method} answered ${res.status}`,
  };
}

/** A 4xx other than rate limiting is about the bot or the request; no retry fixes it. */
function isRefusal(answer: Extract<Answer, { ok: false }>): boolean {
  return answer.status >= 400 && answer.status < 500 && answer.status !== 429;
}

// ---- the entry ---------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const TELEGRAM_NEW_MESSAGE: EventTypeDef = {
  id: "telegram.new_message",
  provider: "telegram",
  app: "Telegram",
  label: "Message to your bot",
  description:
    "Runs when a chat you have paired with your Telegram bot sends it a message, and answers in that chat.",
  requires: { kind: "none" },
  config: z.object({ contains: optionalText(200) }),
  secret: {
    key: "botToken",
    schema: z
      .string({ message: "paste the token @BotFather gave you" })
      .trim()
      .regex(BOT_TOKEN, "that does not look like a token from @BotFather"),
  },
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      kind: "secret",
      placeholder: "123456789:AA…",
      help: "Message @BotFather on Telegram, send /newbot, and paste the token it gives you. Use a bot made for this: a bot can only send its messages to one place.",
    },
    {
      key: "contains",
      label: "Only messages containing",
      kind: "text",
      optional: true,
      placeholder: "report",
      help: "Empty means every message from a paired chat.",
      advanced: true,
    },
  ],
  matches: (config, event) => {
    const wanted = str(config.contains).toLowerCase();
    return !wanted || (event.fields?.text ?? "").toLowerCase().includes(wanted);
  },
  sample: {
    eventId: "sample",
    text:
      lines([
        ["From", "Ayşe (@ayse)"],
        ["Chat", "a private chat"],
      ]) + "\n\nCan you sum up yesterday's sales for me?",
    fields: { text: "Can you sum up yesterday's sales for me?", chat: "1" },
  },
};

export const TELEGRAM_EVENTS: readonly { def: EventTypeDef }[] = [{ def: TELEGRAM_NEW_MESSAGE }];

// ---- reading an update ---------------------------------------------------------------

type PairedChat = { id: string; title: string };

function chatsOf(state: Record<string, unknown> | null | undefined): PairedChat[] {
  const list = Array.isArray(state?.chats) ? state.chats : [];
  return list
    .map(rec)
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => ({ id: str(c.id), title: str(c.title) }))
    .filter((c) => c.id);
}

/** The update's message, its chat and sender — or null for any other kind of update. */
function messageOf(raw: unknown): {
  updateId: string;
  message: Record<string, unknown>;
  chat: Record<string, unknown>;
  from: Record<string, unknown> | null;
} | null {
  const delivery = rec(raw) as TelegramDelivery | null;
  if (!delivery || typeof delivery.body !== "string") return null;
  let update: Record<string, unknown> | null;
  try {
    update = rec(JSON.parse(delivery.body));
  } catch {
    return null;
  }
  const message = rec(update?.message);
  const chat = rec(message?.chat);
  if (!update || !message || !chat || !str(chat.id)) return null;
  return { updateId: str(update.update_id), message, chat, from: rec(message.from) };
}

function chatTitle(chat: Record<string, unknown>): string {
  if (str(chat.type) === "private") return "a private chat";
  return str(chat.title) || str(chat.username) || "a group";
}

function who(from: Record<string, unknown> | null): string {
  if (!from) return "";
  const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ");
  const handle = str(from.username);
  return handle ? `${name || handle} (@${handle})` : name;
}

const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/;

// ---- the adapter ---------------------------------------------------------------------

export function telegramAdapter(deps: TelegramDeps = {}): EventAdapter {
  const dbFor = deps.db ?? serviceClient;

  /** Other routines listening through the same bot, which share its webhook. */
  async function siblings(ctx: AdapterContext): Promise<number> {
    const externalId = ctx.subscription.external_id;
    if (!externalId) return 0;
    const { data, error } = await dbFor(ctx.env)
      .from("routine_event_subscriptions")
      .select("routine_id")
      .eq("provider", "telegram")
      .eq("external_id", externalId)
      .neq("routine_id", ctx.subscription.routine_id);
    if (error) throw new Error(`could not read the bot's other routines: ${error.message}`);
    return (data ?? []).length;
  }

  return {
    provider: "telegram",
    isConfigured: (env) => Boolean(env.WORKER_HOST && env.ROUTINE_SECRET_KEY),

    async subscribe(ctx): Promise<SubscribeResult> {
      const token = ctx.secret;
      if (!token) {
        throw new EventSourceError(
          "The bot's token is missing. Choose the event again and paste the token.",
        );
      }
      const me = await callBot(token, "getMe", {}, deps);
      if (!me.ok) {
        if (isRefusal(me)) {
          throw new EventSourceError(
            "Telegram did not accept that bot token. Check it with @BotFather, then choose the event again.",
          );
        }
        throw new Error(`telegram ${me.description}`);
      }
      const bot = rec(me.result);
      const botId = str(bot?.id);
      if (!botId) throw new Error("telegram getMe answered without an id");
      const externalId = `tg_${botId}`;
      const host = str(ctx.env.WORKER_HOST)
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      const hooked = await callBot(
        token,
        "setWebhook",
        {
          url: `https://${host}/routine-events/telegram/${externalId}`,
          secret_token: await webhookToken(ctx.env, externalId),
          allowed_updates: ["message"],
        },
        deps,
      );
      if (!hooked.ok) {
        if (isRefusal(hooked)) {
          throw new EventSourceError(
            `Telegram refused to send this bot's messages here: ${hooked.description}`,
          );
        }
        throw new Error(`telegram ${hooked.description}`);
      }
      return {
        externalId,
        // Chats already paired survive a re-subscribe (a resume, a retry).
        state: {
          botId,
          botUsername: str(bot?.username),
          chats: chatsOf(ctx.subscription.state),
        },
      };
    },

    // The bot's webhook is shared by every routine on it; only the last one
    // out takes it down. Best-effort: a webhook left behind delivers to an id
    // nothing holds, which the route answers 200 so Telegram stops.
    async unsubscribe(ctx) {
      if (!ctx.secret || (await siblings(ctx)) > 0) return;
      const done = await callBot(ctx.secret, "deleteWebhook", {}, deps);
      if (!done.ok)
        console.error(`telegram deleteWebhook for ${ctx.routine.id}: ${done.description}`);
    },

    // Nothing to pause at Telegram — the webhook is shared, and an update for
    // a paused routine is refused in `receive.ts` for the cost of a request.
    async setEnabled() {},

    async handshake(raw, ctx) {
      const read = messageOf(raw);
      if (!read) return null;
      const code = START.exec(str(read.message.text))?.[1];
      if (!code || code !== (await pairingCode(ctx.env, ctx.routine.id))) return null;
      const chats = chatsOf(ctx.subscription.state);
      const id = str(read.chat.id);
      if (!chats.some((c) => c.id === id)) {
        if (chats.length >= MAX_CHATS) chats.shift();
        chats.push({ id, title: chatTitle(read.chat) });
      }
      if (ctx.secret) {
        await callBot(
          ctx.secret,
          "sendMessage",
          {
            chat_id: id,
            text: "This chat is connected. Messages sent here start the routine, and its answer comes back here.",
          },
          deps,
        );
      }
      return { state: { ...(ctx.subscription.state ?? {}), chats } };
    },

    async normalize(raw, ctx) {
      const read = messageOf(raw);
      if (!read || read.from?.is_bot === true) return null;
      const chatId = str(read.chat.id);
      // Only a chat that paired with this routine. Everybody else's message
      // to the bot — and a stray /start — stops here, before it costs anything.
      if (!chatsOf(ctx.subscription.state).some((c) => c.id === chatId)) return null;
      const text = str(read.message.text) || str(read.message.caption);
      if (!text || START.test(text)) return null;
      const sender = who(read.from);
      const messageId = Number(read.message.message_id);
      return {
        eventId: `${ctx.subscription.external_id ?? "tg"}:${read.updateId}`,
        text: `${lines([
          ["From", sender],
          ["Chat", chatTitle(read.chat)],
        ])}\n\n${clip(text)}`,
        label: `Telegram · ${sender || "message"}`.slice(0, 120),
        fields: { text, chat: chatId },
        replyTo: {
          provider: "telegram",
          chatId,
          ...(Number.isFinite(messageId) ? { messageId } : {}),
        },
      };
    },
  };
}

export const TELEGRAM_ADAPTER = telegramAdapter();

// ---- answering in the chat ------------------------------------------------------------

/** What a chat is told when the run had no report to send it. */
function replyFor(result: RunResult): string | null {
  if (result.status === "ok" && result.summary) return result.summary;
  if (result.status === "skipped") return "Nothing to report on that one.";
  if (result.status === "waiting") {
    return "Still working on this one. The answer goes to the routine's delivery channel when it is ready.";
  }
  if (result.status === "failed") {
    return "The routine could not finish this one. Its owner can see why in the run history.";
  }
  return null;
}

/**
 * Answer the chat a message came from, once its run is done. Reads the
 * routine's subscription with the service role for the bot's token — the
 * only way to send as the bot — and checks the chat is still one it is
 * paired with, so a trigger cannot be pointed at a chat the routine never
 * heard from. Never throws: the run is over and recorded either way.
 */
export async function replyToTelegram(
  env: RoutineEnv,
  routineId: string,
  replyTo: EventReplyTo,
  result: RunResult,
  deps: TelegramDeps = {},
): Promise<void> {
  const text = replyFor(result);
  if (!text) return;
  try {
    const { data, error } = await (deps.db ?? serviceClient)(env)
      .from("routine_event_subscriptions")
      .select("provider, secret_ciphertext, state")
      .eq("routine_id", routineId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as {
      provider: string;
      secret_ciphertext: string | null;
      state: Record<string, unknown> | null;
    } | null;
    if (!row || row.provider !== "telegram" || !row.secret_ciphertext) return;
    if (!chatsOf(row.state).some((c) => c.id === replyTo.chatId)) return;
    const token = await decryptSecret(row.secret_ciphertext, env.ROUTINE_SECRET_KEY);
    const sent = await callBot(
      token,
      "sendMessage",
      {
        chat_id: replyTo.chatId,
        text: clip(text, MAX_MESSAGE_CHARS),
        link_preview_options: { is_disabled: true },
        ...(replyTo.messageId
          ? {
              reply_parameters: {
                message_id: replyTo.messageId,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      },
      deps,
    );
    if (!sent.ok) console.error(`telegram reply for routine ${routineId}: ${sent.description}`);
  } catch (err) {
    console.error(`telegram reply for routine ${routineId} failed`, err);
  }
}
