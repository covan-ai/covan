import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import { encryptSecret } from "../../secret-box";
import type { InstallationRow, SlackEvent } from "../../slack/handle";
import { deliverSlackEvent } from "./slack-deliver";
import type { SlackDelivery } from "./slack";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY } as never;

const installation = async (): Promise<InstallationRow> => ({
  id: "inst-1",
  workspace_id: "w1",
  team_id: "T1",
  bot_user_id: "UBOT",
  secret_ciphertext: await encryptSecret("xoxb-token", KEY),
  agent_id: null,
});

const sub = (routineId: string, over: Row = {}): Row => ({
  routine_id: routineId,
  provider: "slack",
  external_id: "T1",
  event_type: "slack.new_message",
  status: "active",
  state: { teamId: "T1", channelId: "C1", channelName: "support" },
  ...over,
});

const message = (over: Partial<SlackEvent> = {}): SlackEvent => ({
  type: "message",
  channel_type: "channel",
  channel: "C1",
  user: "U9",
  text: "hello",
  ts: "1.0",
  ...over,
});

function slackApi() {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const method = String(url).split("/api/")[1];
    asked.push(method);
    const answers: Record<string, unknown> = {
      "users.info": { ok: true, user: { profile: { display_name: "Ayşe" } } },
      "chat.getPermalink": { ok: true, permalink: "https://acme.slack.com/p1" },
      "conversations.history": {
        ok: true,
        messages: [{ ts: "5.0", text: "Order failed", user: "U3" }],
      },
    };
    return new Response(JSON.stringify(answers[method] ?? { ok: false, error: "nope" }));
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

async function deliver(rows: Row[], event: SlackEvent, eventId = "Ev1") {
  const { db } = memoryDb({ routine_event_subscriptions: rows });
  const { asked, fetchImpl } = slackApi();
  const receive = vi.fn(async (..._args: unknown[]) => ({
    status: "accepted" as const,
    eventId: "x",
  }));
  await deliverSlackEvent(ENV, await installation(), event, eventId, {
    db: db as unknown as SupabaseClient,
    fetchImpl,
    defer: () => {},
    run: async () => {},
    receive: receive as never,
  });
  return { asked, receive };
}

describe("deliverSlackEvent", () => {
  it("hands the event to each routine waiting on this channel, or on any", async () => {
    const { receive } = await deliver(
      [
        sub("r-here"),
        sub("r-anywhere", { state: { teamId: "T1" } }),
        sub("r-elsewhere", { state: { teamId: "T1", channelId: "C2" } }),
        sub("r-other-team", { external_id: "T2" }),
        sub("r-paused", { status: "disabled" }),
        sub("r-reactions", { event_type: "slack.reaction_added" }),
      ],
      message(),
    );
    const routines = receive.mock.calls.map((c) => (c[1] as { routineId: string }).routineId);
    expect(routines.sort()).toEqual(["r-anywhere", "r-here"]);
    const delivered = receive.mock.calls[0][2] as SlackDelivery;
    expect(delivered).toMatchObject({
      kind: "message",
      eventId: "Ev1",
      channel: "C1",
      channelName: "support",
      user: "U9",
      userName: "Ayşe",
      text: "hello",
      permalink: "https://acme.slack.com/p1",
    });
  });

  it("asks Slack nothing when nobody is waiting", async () => {
    const { asked, receive } = await deliver(
      [sub("r1", { event_type: "slack.reaction_added" })],
      message(),
    );
    expect(asked).toEqual([]);
    expect(receive).not.toHaveBeenCalled();
  });

  it("asks Slack once, however many routines are waiting", async () => {
    const { asked, receive } = await deliver([sub("r1"), sub("r2"), sub("r3")], message());
    expect(receive).toHaveBeenCalledTimes(3);
    expect(asked.sort()).toEqual(["chat.getPermalink", "users.info"]);
  });

  it("ignores the app's own message", async () => {
    const { asked, receive } = await deliver([sub("r1")], message({ user: "UBOT" }));
    expect(asked).toEqual([]);
    expect(receive).not.toHaveBeenCalled();
  });

  it("reads the message a reaction was on, and who wrote it", async () => {
    const { receive } = await deliver(
      [sub("r1", { event_type: "slack.reaction_added", state: { teamId: "T1" } })],
      {
        type: "reaction_added",
        user: "U9",
        reaction: "eyes",
        item: { type: "message", channel: "C1", ts: "5.0" },
      },
    );
    expect(receive.mock.calls[0][2]).toMatchObject({
      kind: "reaction",
      reaction: "eyes",
      text: "Order failed",
      author: "Ayşe",
    });
  });

  it("makes an id from the message when Slack's is missing, and keeps going past a failure", async () => {
    const { db } = memoryDb({ routine_event_subscriptions: [sub("r1"), sub("r2")] });
    const { fetchImpl } = slackApi();
    const receive = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "accepted", eventId: "x" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await deliverSlackEvent(ENV, await installation(), message(), "", {
      db: db as unknown as SupabaseClient,
      fetchImpl,
      defer: () => {},
      run: async () => {},
      receive: receive as never,
    });
    error.mockRestore();
    expect(receive).toHaveBeenCalledTimes(2);
    expect((receive.mock.calls[1][2] as SlackDelivery).eventId).toBe("message:C1:1.0::U9");
  });
});
