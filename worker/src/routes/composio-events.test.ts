import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { resetRateLimiters } from "../lib/ratelimit";
import { resetMisses } from "../middleware/ratelimit";

const receiveEvent = vi.fn();
const lapseSubscriptions = vi.fn(async () => []);
const cancelOrphanTrigger = vi.fn(async () => {});
const announceLapsedSubscription = vi.fn();

vi.mock("../lib/routines/events/receive", () => ({ receiveEvent }));
vi.mock("../lib/routines/events/lifecycle", () => ({ lapseSubscriptions }));
vi.mock("../lib/routines/events/composio", () => ({ cancelOrphanTrigger }));
vi.mock("../lib/routines/dispatcher", () => ({ announceLapsedSubscription }));

const { composioEvents } = await import("./composio-events");

const SECRET = "composio-test-secret";
const ENV = { COMPOSIO_WEBHOOK_SECRET: SECRET, RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20" };

async function signed(body: string, opts: { secret?: string; at?: number; id?: string } = {}) {
  const id = opts.id ?? "msg_1";
  const timestamp = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.secret ?? SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`,
  };
}

function post(body: string, headers: Record<string, string>, env: Record<string, string> = ENV) {
  const app = new Hono<AppEnv>();
  app.route("/", composioEvents);
  return app.request(
    "/composio/events",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body },
    env as never,
  );
}

const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: "ti_abc", connected_account_id: "ca_1" },
    data: { message_id: "m1" },
    ...over,
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  receiveEvent.mockReset().mockResolvedValue({ status: "accepted", eventId: "composio:gmail:m1" });
  lapseSubscriptions.mockClear();
  cancelOrphanTrigger.mockClear();
  resetRateLimiters();
  resetMisses();
});

describe("POST /composio/events", () => {
  it("hands a signed trigger delivery to receiveEvent, by its trigger id", async () => {
    const body = message();
    const res = await post(body, await signed(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
    expect(receiveEvent).toHaveBeenCalledOnce();
    const [, target, raw] = receiveEvent.mock.calls[0];
    expect(target).toEqual({ provider: "composio", externalId: "ti_abc" });
    expect(raw).toMatchObject({ data: { message_id: "m1" } });
  });

  it("refuses an unsigned or wrongly signed delivery before reading it", async () => {
    const body = message();
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, await signed(body, { secret: "another" }))).status).toBe(401);
    expect((await post(message({ data: { forged: true } }), await signed(body))).status).toBe(401);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("refuses a replay older than the window", async () => {
    const body = message();
    const res = await post(body, await signed(body, { at: Date.now() - 10 * 60_000 }));
    expect(res.status).toBe(401);
  });

  it("is not there at all on a deployment that never asked Composio for deliveries", async () => {
    const body = message();
    const res = await post(body, await signed(body), {});
    expect(res.status).toBe(404);
  });

  it("acknowledges an event kind it does not handle, so it is not retried", async () => {
    const body = JSON.stringify({ id: "msg_2", type: "composio.connected_account.activated" });
    const res = await post(body, await signed(body, { id: "msg_2" }));
    expect(res.status).toBe(200);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("ignores a trigger id that is not shaped like one", async () => {
    const body = message({ metadata: { trigger_id: "ti_1,status.eq.active" } });
    const res = await post(body, await signed(body));
    expect(res.status).toBe(200);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("ends a trigger nothing is waiting for", async () => {
    receiveEvent.mockResolvedValue({ status: "unknown" });
    const body = message();
    await post(body, await signed(body));
    await settle();
    expect(cancelOrphanTrigger).toHaveBeenCalledWith(expect.anything(), "ti_abc");
  });

  it("answers 200 for a filtered or paused delivery, so Composio does not resend it", async () => {
    receiveEvent.mockResolvedValue({ status: "inactive" });
    const body = message();
    const res = await post(body, await signed(body));
    expect(res.status).toBe(200);
    expect(cancelOrphanTrigger).not.toHaveBeenCalled();
  });

  it("lapses the routines listening through an expired account", async () => {
    const body = JSON.stringify({
      id: "msg_3",
      type: "composio.connected_account.expired",
      metadata: { project_id: "p1" },
      data: { id: "ca_1", status: "EXPIRED", toolkit: { slug: "gmail" } },
    });
    const res = await post(body, await signed(body, { id: "msg_3" }));
    await settle();
    expect(res.status).toBe(200);
    expect(lapseSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      { state: { connectedAccountId: "ca_1" } },
      expect.stringContaining("expired"),
      { announce: announceLapsedSubscription },
    );
  });

  it("lapses the routines of a trigger Composio switched off by itself", async () => {
    const body = JSON.stringify({
      id: "msg_4",
      type: "composio.trigger.disabled",
      data: { id: "ti_abc", connected_account_id: "ca_1", disabled_reason: "auth expired" },
    });
    await post(body, await signed(body, { id: "msg_4" }));
    await settle();
    expect(lapseSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      { provider: "composio", externalId: "ti_abc" },
      expect.any(String),
      { announce: announceLapsedSubscription },
    );
  });

  it("counts deliveries per trigger, so one routine's burst cannot crowd out another's", async () => {
    const env = { ...ENV, RATE_LIMIT_EXPENSIVE_PER_MINUTE: "2" };
    const body = message();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(body, await signed(body), env)).status);
    expect(statuses).toEqual([200, 200, 429]);

    const other = message({ metadata: { trigger_id: "ti_other" } });
    expect((await post(other, await signed(other), env)).status).toBe(200);
  });

  it("refuses an oversized delivery", async () => {
    const body = message({ data: { text: "x".repeat(300 * 1024) } });
    const res = await post(body, await signed(body));
    expect(res.status).toBe(413);
  });
});
