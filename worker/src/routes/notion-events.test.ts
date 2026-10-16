import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { hmacSha256Hex } from "../lib/hmac";
import { resetRateLimiters } from "../lib/ratelimit";
import { resetMisses } from "../middleware/ratelimit";

const receiveEvent = vi.fn();
const startPokedRun = vi.fn(async () => {});

vi.mock("../lib/routines/events/receive", () => ({ receiveEvent }));
vi.mock("../lib/routines/poke-room", () => ({ startPokedRun }));

const { notionEvents } = await import("./notion-events");

const TOKEN = "secret_abcdefghijklmnopqrstuvwxyz";
const ENV = {
  NOTION_CLIENT_ID: "id",
  NOTION_WEBHOOK_VERIFICATION_TOKEN: TOKEN,
  RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20",
};
const BOT_A = "11111111-2222-3333-4444-555555555555";
const BOT_B = "66666666-7777-8888-9999-000000000000";

function post(
  body: string,
  headers: Record<string, string> = {},
  env: Record<string, string> = ENV,
) {
  const app = new Hono<AppEnv>();
  app.route("/", notionEvents);
  return app.request(
    "/notion/events",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body },
    env as never,
  );
}

async function signed(payload: unknown, key = TOKEN) {
  const body = JSON.stringify(payload);
  return { body, headers: { "X-Notion-Signature": `sha256=${await hmacSha256Hex(key, body)}` } };
}

const event = (over: Record<string, unknown> = {}) => ({
  id: "evt-1",
  type: "page.created",
  workspace_id: "ws-1",
  accessible_by: [
    { id: BOT_A, type: "bot" },
    { id: BOT_B, type: "bot" },
    { id: "person-1", type: "person" },
  ],
  entity: { id: "p1", type: "page" },
  ...over,
});

beforeEach(() => {
  receiveEvent.mockReset().mockResolvedValue({ status: "accepted", eventId: "notion:evt-1" });
  resetRateLimiters();
  resetMisses();
});

describe("POST /notion/events", () => {
  it("offers a signed delivery to each connection that can see the page", async () => {
    const { body, headers } = await signed(event());
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
    expect(receiveEvent.mock.calls.map((c) => c[1])).toEqual([
      { provider: "notion", externalId: BOT_A },
      { provider: "notion", externalId: BOT_B },
    ]);
  });

  it("refuses a delivery signed with anything else", async () => {
    const { body } = await signed(event());
    const forged = await signed(event(), "secret_someoneelse0000");
    expect((await post(body, forged.headers)).status).toBe(401);
    expect((await post(body, {})).status).toBe(401);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("logs the handshake's token for the operator, configured or not", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const handshake = JSON.stringify({ verification_token: TOKEN });
    const before = await post(handshake, {}, { NOTION_CLIENT_ID: "id" });
    expect(before.status).toBe(200);
    expect(log.mock.calls[0][0]).toContain(TOKEN);
    expect((await post(handshake)).status).toBe(200);
    log.mockRestore();
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("accepts nothing but the handshake until the token is set", async () => {
    const { body, headers } = await signed(event());
    expect((await post(body, headers, { NOTION_CLIENT_ID: "id" })).status).toBe(404);
  });

  it("is not there at all without a Notion integration", async () => {
    expect((await post(JSON.stringify({ verification_token: TOKEN }), {}, {})).status).toBe(404);
  });

  it("acknowledges event kinds it has no use for", async () => {
    const { body, headers } = await signed(event({ type: "page.locked" }));
    const res = await post(body, headers);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(receiveEvent).not.toHaveBeenCalled();
  });
});
