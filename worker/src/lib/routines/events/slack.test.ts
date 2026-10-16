import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import { encryptSecret } from "../../secret-box";
import type { SlackEvent } from "../../slack/handle";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { EventSourceError } from "./errors";
import {
  SLACK_EVENTS,
  classifySlackEvent,
  emojiName,
  readableSlackText,
  slackAdapter,
  type SlackDelivery,
} from "./slack";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY } as never;
const ALL_SCOPES = ["channels:history", "groups:history", "reactions:read", "channels:read"];

async function install(over: Row = {}): Promise<Row> {
  return {
    id: "inst-1",
    workspace_id: "w1",
    team_id: "T1",
    scopes: ALL_SCOPES,
    secret_ciphertext: await encryptSecret("xoxb-token", KEY),
    ...over,
  };
}

function ctx(type: string, config: Record<string, unknown>, state: Record<string, unknown> = {}) {
  const def = CATALOGUE.eventType(type);
  if (!def) throw new Error(type);
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "slack",
      event_type: type,
      config: { connectionId: "inst-1", ...config },
      external_id: null,
      secret_ciphertext: null,
      state,
      status: "pending",
      status_detail: null,
      expires_at: null,
      attempts: 0,
    } satisfies SubscriptionRow,
    eventType: def,
    secret: null,
  } satisfies AdapterContext;
}

/** A Slack Web API that answers each method from `answers`. */
function slackApi(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const method = String(url).split("/api/")[1];
    asked.push(method);
    return new Response(JSON.stringify(answers[method] ?? { ok: false, error: "unknown_method" }));
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe("the Slack entries", () => {
  it("are in the catalogue, served by slack, needing the Slack install", () => {
    for (const def of SLACK_EVENTS) {
      expect(CATALOGUE.eventType(def.id)).toBe(def);
      expect(def.provider).toBe("slack");
      expect(def.requires).toEqual({ kind: "slack" });
    }
  });

  it("matches messages by what they contain and who wrote them", () => {
    const message = SLACK_EVENTS.find((d) => d.id === "slack.new_message")!;
    const at = (fields: Record<string, string>) => ({ eventId: "e", text: "", fields });
    const said = at({ text: "Invoice 42 is overdue", user: "U9", userName: "Ayşe Demir" });
    expect(message.matches!({ channel: "#x" }, said)).toBe(true);
    expect(message.matches!({ contains: "INVOICE" }, said)).toBe(true);
    expect(message.matches!({ contains: "refund" }, said)).toBe(false);
    expect(message.matches!({ from: "@ayşe demir" }, said)).toBe(true);
    expect(message.matches!({ from: "U9" }, said)).toBe(true);
    expect(message.matches!({ from: "Mert" }, said)).toBe(false);
  });

  it("matches a reaction by its emoji, however it was written", () => {
    const reaction = SLACK_EVENTS.find((d) => d.id === "slack.reaction_added")!;
    const config = reaction.config.parse({ emoji: ":White_Check_Mark:" });
    expect(config.emoji).toBe("white_check_mark");
    const at = (r: string) => ({ eventId: "e", text: "", fields: { reaction: r } });
    expect(reaction.matches!(config, at("white_check_mark"))).toBe(true);
    expect(reaction.matches!(config, at("eyes"))).toBe(false);
    expect(emojiName("+1::skin-tone-3")).toBe("+1");
  });
});

describe("classifySlackEvent", () => {
  const message = (over: Partial<SlackEvent> = {}): SlackEvent => ({
    type: "message",
    channel_type: "channel",
    channel: "C1",
    user: "U1",
    text: "hello",
    ts: "1.0",
    ...over,
  });

  it("takes a person's message in a channel or a private channel", () => {
    expect(classifySlackEvent(message(), "UBOT")).toEqual({
      kind: "message",
      channel: "C1",
      user: "U1",
      ts: "1.0",
    });
    expect(classifySlackEvent(message({ channel_type: "group" }), "UBOT")?.kind).toBe("message");
    expect(classifySlackEvent(message({ subtype: "file_share" }), "UBOT")?.kind).toBe("message");
  });

  it("never takes the app's own words, a bot's, an edit, or a DM", () => {
    expect(classifySlackEvent(message({ user: "UBOT" }), "UBOT")).toBeNull();
    expect(classifySlackEvent(message({ bot_id: "B1" }), "UBOT")).toBeNull();
    expect(classifySlackEvent(message({ subtype: "message_changed" }), "UBOT")).toBeNull();
    expect(classifySlackEvent(message({ channel_type: "im" }), "UBOT")).toBeNull();
    expect(classifySlackEvent(message({ text: "  " }), "UBOT")).toBeNull();
    expect(classifySlackEvent({ ...message(), type: "app_mention" }, "UBOT")).toBeNull();
  });

  it("takes a reaction to a message, and not the app's own", () => {
    const reaction: SlackEvent = {
      type: "reaction_added",
      user: "U2",
      reaction: "eyes",
      item: { type: "message", channel: "C1", ts: "5.0" },
    };
    expect(classifySlackEvent(reaction, "UBOT")).toEqual({
      kind: "reaction",
      channel: "C1",
      user: "U2",
      ts: "5.0",
    });
    expect(classifySlackEvent({ ...reaction, user: "UBOT" }, "UBOT")).toBeNull();
    expect(classifySlackEvent({ ...reaction, item: { type: "file" } }, "UBOT")).toBeNull();
  });
});

describe("readableSlackText", () => {
  it("turns Slack's markup into what a person would read", () => {
    expect(
      readableSlackText("see <#C1|general> and <https://e.com|the doc> &amp; <https://x.io>"),
    ).toBe("see #general and the doc (https://e.com) & https://x.io");
  });
});

describe("slackAdapter.subscribe", () => {
  it("records the team and the channel a name resolves to", async () => {
    const { db } = memoryDb({ slack_installations: [await install()] });
    const { fetchImpl } = slackApi({
      "conversations.list": {
        ok: true,
        channels: [{ id: "C0123ABCD", name: "support", is_member: true }],
      },
    });
    const adapter = slackAdapter({ db: db as unknown as SupabaseClient, fetchImpl });
    expect(await adapter.subscribe(ctx("slack.new_message", { channel: "#Support" }))).toEqual({
      externalId: "T1",
      state: { teamId: "T1", channelId: "C0123ABCD", channelName: "support" },
    });
  });

  it("asks for an invite when the app is not in the channel", async () => {
    const { db } = memoryDb({ slack_installations: [await install()] });
    const { fetchImpl } = slackApi({
      "conversations.info": {
        ok: true,
        channel: { id: "C0123ABCD", name: "support", is_member: false },
      },
    });
    const adapter = slackAdapter({ db: db as unknown as SupabaseClient, fetchImpl });
    await expect(
      adapter.subscribe(ctx("slack.new_message", { channel: "C0123ABCD" })),
    ).rejects.toThrow(/\/invite @Covan/);
  });

  it("asks for a reconnect when the install predates the scopes it needs", async () => {
    const { db } = memoryDb({ slack_installations: [await install({ scopes: null })] });
    const adapter = slackAdapter({ db: db as unknown as SupabaseClient });
    await expect(adapter.subscribe(ctx("slack.reaction_added", { emoji: "eyes" }))).rejects.toThrow(
      /Reconnect Slack/,
    );
  });

  it("calls an install in another workspace, or none, no longer connected", async () => {
    const { db } = memoryDb({ slack_installations: [await install({ workspace_id: "w2" })] });
    const adapter = slackAdapter({ db: db as unknown as SupabaseClient });
    const err = await adapter
      .subscribe(ctx("slack.reaction_added", { emoji: "eyes" }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventSourceError);
    expect((err as EventSourceError).expired).toBe(true);
  });

  it("listens to every channel for a reaction with no channel named", async () => {
    const { db } = memoryDb({ slack_installations: [await install()] });
    const adapter = slackAdapter({ db: db as unknown as SupabaseClient });
    expect(await adapter.subscribe(ctx("slack.reaction_added", { emoji: "eyes" }))).toEqual({
      externalId: "T1",
      state: { teamId: "T1" },
    });
  });
});

describe("slackAdapter.normalize", () => {
  const delivery = (over: Partial<SlackDelivery> = {}): SlackDelivery => ({
    kind: "message",
    eventId: "Ev1",
    teamId: "T1",
    channel: "C0123ABCD",
    channelName: "support",
    user: "U9",
    userName: "Ayşe Demir",
    text: "Export is <https://e.com|broken>",
    ts: "1.0",
    permalink: "https://acme.slack.com/archives/C0123ABCD/p1",
    ...over,
  });
  const adapter = slackAdapter();

  it("describes a message: channel, who, link, text", async () => {
    const event = await adapter.normalize(
      delivery(),
      ctx("slack.new_message", { channel: "#support" }, { channelId: "C0123ABCD" }),
    );
    expect(event).toMatchObject({
      eventId: "Ev1",
      label: "Slack · New message in #support",
      fields: { text: "Export is broken (https://e.com)", user: "U9", userName: "Ayşe Demir" },
    });
    expect(event?.text).toContain("From: Ayşe Demir");
    expect(event?.text).toContain("Link: https://acme.slack.com/archives/C0123ABCD/p1");
  });

  it("describes a reaction with the message it was on", async () => {
    const event = await adapter.normalize(
      delivery({ kind: "reaction", reaction: "eyes", author: "Mert", text: "Order 4417 failed" }),
      ctx("slack.reaction_added", { emoji: "eyes" }),
    );
    expect(event?.text).toContain("Reaction: :eyes:");
    expect(event?.text).toContain("Message by: Mert");
    expect(event?.text).toContain("Order 4417 failed");
    expect(event?.fields?.reaction).toBe("eyes");
  });

  it("runs nothing for another channel or another kind of event", async () => {
    const c = ctx("slack.new_message", { channel: "#support" }, { channelId: "C0123ABCD" });
    expect(await adapter.normalize(delivery({ channel: "C88" }), c)).toBeNull();
    expect(await adapter.normalize(delivery({ kind: "reaction" }), c)).toBeNull();
  });
});
