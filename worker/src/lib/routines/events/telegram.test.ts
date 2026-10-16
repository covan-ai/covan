import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb } from "../../../test-support/memory-db";
import { encryptSecret } from "../../secret-box";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE, parseEventChoice } from "./catalog";
import { EventSourceError } from "./errors";
import {
  TELEGRAM_HOOK_ID,
  pairingCode,
  replyToTelegram,
  telegramAdapter,
  webhookToken,
} from "./telegram";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY, WORKER_HOST: "api.example.com" } as never;
const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra";
const DEF = CATALOGUE.eventType("telegram.new_message")!;

function ctx(over: Partial<SubscriptionRow> = {}, secret: string | null = TOKEN) {
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "telegram",
      event_type: DEF.id,
      config: {},
      external_id: "tg_123456789",
      secret_ciphertext: "sealed",
      state: {
        botId: "123456789",
        botUsername: "acme_bot",
        chats: [{ id: "42", title: "a private chat" }],
      },
      status: "active",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: DEF,
    secret,
  } satisfies AdapterContext;
}

/** A Bot API that answers each method from a table and remembers what it was asked. */
function botApi(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; payload: Record<string, unknown>; url: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method, url: String(url), payload: JSON.parse(String(init?.body ?? "{}")) });
    const answer = answers[method] ?? { body: { ok: true, result: true } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const update = (message: Record<string, unknown>, updateId = 900) => ({
  body: JSON.stringify({
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_760_000_000,
      chat: { id: 42, type: "private" },
      from: { id: 5, is_bot: false, first_name: "Ayşe", username: "ayse" },
      ...message,
    },
  }),
});

describe("the Telegram entry", () => {
  it("keeps the bot token out of config, and refuses one that is not a token", () => {
    const parsed = parseEventChoice(CATALOGUE, DEF.id, {
      botToken: ` ${TOKEN} `,
      contains: "report",
    });
    expect(parsed).toEqual({
      ok: true,
      choice: { def: DEF, config: { contains: "report" }, secret: TOKEN },
    });
    const bad = parseEventChoice(CATALOGUE, DEF.id, { botToken: "hello" });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/^botToken: /) });
    expect(parseEventChoice(CATALOGUE, DEF.id, {})).toMatchObject({ ok: false });
  });

  it("filters on the text when asked to", () => {
    const at = (text: string) => ({ eventId: "e", text, fields: { text } });
    expect(DEF.matches!({}, at("anything"))).toBe(true);
    expect(DEF.matches!({ contains: "Report" }, at("weekly report please"))).toBe(true);
    expect(DEF.matches!({ contains: "report" }, at("hello"))).toBe(false);
  });
});

describe("the derived secrets", () => {
  it("differ by webhook and by routine, and fit what Telegram accepts", async () => {
    const a = await webhookToken(ENV, "tg_1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(await webhookToken(ENV, "tg_2")).not.toBe(a);
    const code = await pairingCode(ENV, "r1");
    expect(code).toMatch(/^[0-9a-f]{24}$/);
    expect(await pairingCode(ENV, "r2")).not.toBe(code);
  });
});

describe("telegramAdapter.subscribe", () => {
  it("points the bot's webhook at its own URL, with the derived token, and keeps paired chats", async () => {
    const api = botApi({
      getMe: { body: { ok: true, result: { id: 123456789, username: "acme_bot" } } },
    });
    const result = await telegramAdapter({ fetchImpl: api.fetchImpl }).subscribe(ctx());

    expect(result).toEqual({
      externalId: "tg_123456789",
      state: {
        botId: "123456789",
        botUsername: "acme_bot",
        chats: [{ id: "42", title: "a private chat" }],
      },
    });
    expect(result.externalId).toMatch(TELEGRAM_HOOK_ID);
    const hook = api.calls.find((call) => call.method === "setWebhook")!;
    expect(hook.payload).toEqual({
      url: "https://api.example.com/routine-events/telegram/tg_123456789",
      secret_token: await webhookToken(ENV, "tg_123456789"),
      allowed_updates: ["message"],
    });
  });

  it("calls a token Telegram refuses a sentence, never the URL it was in", async () => {
    const api = botApi({
      getMe: { status: 401, body: { ok: false, description: "Unauthorized" } },
    });
    const err = await telegramAdapter({ fetchImpl: api.fetchImpl })
      .subscribe(ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventSourceError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it("asks for the token again when there is none, and retries Telegram being down", async () => {
    await expect(telegramAdapter().subscribe(ctx({}, null))).rejects.toThrow(EventSourceError);
    const api = botApi({ getMe: { status: 502, body: { ok: false } } });
    const err = await telegramAdapter({ fetchImpl: api.fetchImpl })
      .subscribe(ctx())
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EventSourceError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});

describe("telegramAdapter.unsubscribe", () => {
  it("takes the webhook down only when no other routine shares the bot", async () => {
    const shared = memoryDb({
      routine_event_subscriptions: [
        { routine_id: "r1", provider: "telegram", external_id: "tg_123456789" },
        { routine_id: "r2", provider: "telegram", external_id: "tg_123456789" },
      ],
    });
    const api = botApi({});
    await telegramAdapter({
      fetchImpl: api.fetchImpl,
      db: () => shared.db as unknown as SupabaseClient,
    }).unsubscribe(ctx());
    expect(api.calls).toHaveLength(0);

    const alone = memoryDb({
      routine_event_subscriptions: [
        { routine_id: "r1", provider: "telegram", external_id: "tg_123456789" },
      ],
    });
    await telegramAdapter({
      fetchImpl: api.fetchImpl,
      db: () => alone.db as unknown as SupabaseClient,
    }).unsubscribe(ctx());
    expect(api.calls.map((c) => c.method)).toEqual(["deleteWebhook"]);
  });
});

describe("pairing", () => {
  it("adds a chat that sends this routine's code, says so in the chat, and runs nothing", async () => {
    const api = botApi({});
    const adapter = telegramAdapter({ fetchImpl: api.fetchImpl });
    const code = await pairingCode(ENV, "r1");
    const fresh = ctx({ state: { botUsername: "acme_bot", chats: [] } });
    const answer = await adapter.handshake!(
      update({ text: `/start ${code}`, chat: { id: -100, type: "group", title: "Sales" } }),
      fresh,
    );
    expect(answer).toEqual({
      state: { botUsername: "acme_bot", chats: [{ id: "-100", title: "Sales" }] },
    });
    expect(api.calls[0]).toMatchObject({ method: "sendMessage", payload: { chat_id: "-100" } });
  });

  it("ignores another routine's code, a bare /start, and ordinary messages", async () => {
    const adapter = telegramAdapter({ fetchImpl: botApi({}).fetchImpl });
    const other = await pairingCode(ENV, "r2");
    expect(await adapter.handshake!(update({ text: `/start ${other}` }), ctx())).toBeNull();
    expect(await adapter.handshake!(update({ text: "/start" }), ctx())).toBeNull();
    expect(await adapter.handshake!(update({ text: "hello" }), ctx())).toBeNull();
  });
});

describe("telegramAdapter.normalize", () => {
  const adapter = telegramAdapter();

  it("describes a paired chat's message and says where to answer", async () => {
    const event = await adapter.normalize(update({ text: "Sum up yesterday's sales" }), ctx());
    expect(event).toEqual({
      eventId: "tg_123456789:900",
      text: "From: Ayşe (@ayse)\nChat: a private chat\n\nSum up yesterday's sales",
      label: "Telegram · Ayşe (@ayse)",
      fields: { text: "Sum up yesterday's sales", chat: "42" },
      replyTo: { provider: "telegram", chatId: "42", messageId: 7 },
    });
  });

  it("reads a caption when there is no text", async () => {
    const event = await adapter.normalize(update({ caption: "this receipt" }), ctx());
    expect(event?.fields?.text).toBe("this receipt");
  });

  it("drops an unpaired chat, a bot, a /start, and a message with nothing to read", async () => {
    expect(
      await adapter.normalize(update({ text: "hi", chat: { id: 99, type: "private" } }), ctx()),
    ).toBeNull();
    expect(
      await adapter.normalize(update({ text: "hi", from: { id: 1, is_bot: true } }), ctx()),
    ).toBeNull();
    expect(await adapter.normalize(update({ text: "/start abc" }), ctx())).toBeNull();
    expect(await adapter.normalize(update({ sticker: {} }), ctx())).toBeNull();
    expect(await adapter.normalize({ body: "not json" }, ctx())).toBeNull();
  });
});

describe("replyToTelegram", () => {
  async function rowWith(chats: unknown[]) {
    return memoryDb({
      routine_event_subscriptions: [
        {
          routine_id: "r1",
          provider: "telegram",
          secret_ciphertext: await encryptSecret(TOKEN, KEY),
          state: { chats },
        },
      ],
    });
  }

  it("answers a paired chat with the report, as a reply to the message", async () => {
    const api = botApi({});
    const m = await rowWith([{ id: "42", title: "a private chat" }]);
    await replyToTelegram(
      ENV,
      "r1",
      { provider: "telegram", chatId: "42", messageId: 7 },
      { status: "ok", itemsNew: 1, summary: "Sales were up 4%." },
      { fetchImpl: api.fetchImpl, db: () => m.db as unknown as SupabaseClient },
    );
    expect(api.calls[0].url).toContain(`/bot${TOKEN}/sendMessage`);
    expect(api.calls[0].payload).toMatchObject({
      chat_id: "42",
      text: "Sales were up 4%.",
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
    });
  });

  it("says something even when the run had no report", async () => {
    const api = botApi({});
    const m = await rowWith([{ id: "42", title: "x" }]);
    await replyToTelegram(
      ENV,
      "r1",
      { provider: "telegram", chatId: "42" },
      { status: "skipped", itemsNew: 0 },
      {
        fetchImpl: api.fetchImpl,
        db: () => m.db as unknown as SupabaseClient,
      },
    );
    expect(api.calls[0].payload.text).toMatch(/Nothing to report/);
  });

  it("sends nothing to a chat the routine is not paired with", async () => {
    const api = botApi({});
    const m = await rowWith([{ id: "42", title: "x" }]);
    await replyToTelegram(
      ENV,
      "r1",
      { provider: "telegram", chatId: "777" },
      { status: "ok", itemsNew: 1, summary: "hi" },
      { fetchImpl: api.fetchImpl, db: () => m.db as unknown as SupabaseClient },
    );
    expect(api.calls).toHaveLength(0);
  });
});
