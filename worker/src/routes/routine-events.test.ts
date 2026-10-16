import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { resetRateLimiters } from "../lib/ratelimit";
import { resetMisses } from "../middleware/ratelimit";
import { intentToken } from "../lib/routines/events/websub";

const receiveEvent = vi.fn();
const startPokedRun = vi.fn(async () => {});

vi.mock("../lib/routines/events/receive", () => ({ receiveEvent }));
vi.mock("../lib/routines/poke-room", () => ({ startPokedRun }));

const { routineEvents } = await import("./routine-events");

const ENV = {
  RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20",
  ROUTINE_SECRET_KEY: "k".repeat(32),
  WORKER_HOST: "api.example.com",
};
const GH = "gh_" + "a".repeat(32);
const WS = "ws_" + "b".repeat(32);
const TOPIC = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx";

function call(path: string, init: RequestInit = {}) {
  const app = new Hono<AppEnv>();
  app.route("/", routineEvents);
  return app.request(path, init, ENV as never);
}

function postGitHub(
  id = GH,
  body = '{"ref":"refs/heads/main"}',
  headers: Record<string, string> = {},
) {
  return call(`/routine-events/github/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "d-1",
      "X-Hub-Signature-256": "sha256=abc",
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  receiveEvent.mockReset().mockResolvedValue({ status: "accepted", eventId: "github:d-1" });
  startPokedRun.mockClear();
  resetRateLimiters();
  resetMisses();
});

describe("POST /routine-events/github/:id", () => {
  it("hands GitHub's headers and the unread body to receiveEvent, by the URL's id", async () => {
    const res = await postGitHub();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
    const [, target, raw] = receiveEvent.mock.calls[0];
    expect(target).toEqual({ provider: "github", externalId: GH });
    expect(raw).toEqual({
      event: "push",
      delivery: "d-1",
      signature: "sha256=abc",
      body: '{"ref":"refs/heads/main"}',
    });
  });

  it("starts the run where it can outlive the response", async () => {
    await postGitHub();
    const deps = receiveEvent.mock.calls[0][3] as {
      run: (env: unknown, routine: unknown, trigger: unknown) => Promise<unknown>;
    };
    await deps.run({}, { id: "r1" }, { eventId: "github:d-1" });
    expect(startPokedRun).toHaveBeenCalledWith(
      expect.objectContaining({ WORKER_HOST: "api.example.com" }),
      { id: "r1" },
      { eventId: "github:d-1" },
    );
  });

  it("answers 404 for an id that is not one of ours, without a lookup", async () => {
    const res = await postGitHub("not-an-id");
    expect(res.status).toBe(404);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("answers 404 for a URL nothing holds and 401 for a bad signature", async () => {
    receiveEvent.mockResolvedValueOnce({ status: "unknown" });
    expect((await postGitHub()).status).toBe(404);
    receiveEvent.mockResolvedValueOnce({ status: "forged" });
    expect((await postGitHub()).status).toBe(401);
  });

  it("acknowledges a filtered, ignored or paused delivery, so GitHub does not retry it", async () => {
    for (const status of ["filtered", "ignored", "inactive", "flood"]) {
      receiveEvent.mockResolvedValueOnce({ status });
      expect((await postGitHub()).status).toBe(200);
    }
  });

  it("refuses a body over the cap before reading it", async () => {
    const res = await postGitHub(GH, "x", { "Content-Length": String(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("stops listening to an address that keeps sending bad signatures", async () => {
    receiveEvent.mockResolvedValue({ status: "forged" });
    let last = 0;
    for (let i = 0; i < 30; i++) last = (await postGitHub()).status;
    expect(last).toBe(429);
  });
});

describe("GET /routine-events/websub/:id", () => {
  const verify = async (params: Record<string, string>, id = WS) =>
    call(`/routine-events/websub/${id}?${new URLSearchParams(params).toString()}`);

  it("echoes the challenge for a topic this callback was made for", async () => {
    const t = await intentToken(ENV as never, WS, TOPIC);
    const res = await verify({
      "hub.mode": "subscribe",
      "hub.topic": TOPIC,
      "hub.challenge": "c-123",
      t,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("c-123");
    const bye = await verify({
      "hub.mode": "unsubscribe",
      "hub.topic": TOPIC,
      "hub.challenge": "c-9",
      t,
    });
    expect(await bye.text()).toBe("c-9");
  });

  it("says no to another topic, a missing proof, an odd mode or a malformed id", async () => {
    const t = await intentToken(ENV as never, WS, TOPIC);
    const base = { "hub.mode": "subscribe", "hub.topic": TOPIC, "hub.challenge": "c", t };
    expect((await verify({ ...base, "hub.topic": `${TOPIC}x` })).status).toBe(404);
    expect((await verify({ ...base, t: "" })).status).toBe(404);
    expect((await verify({ ...base, "hub.mode": "denied" })).status).toBe(404);
    expect((await verify(base, "ws_short")).status).toBe(404);
  });
});

describe("POST /routine-events/websub/:id", () => {
  it("hands the hub's signature and the pushed feed to receiveEvent", async () => {
    const res = await call(`/routine-events/websub/${WS}`, {
      method: "POST",
      headers: { "Content-Type": "application/atom+xml", "X-Hub-Signature": "sha1=abc" },
      body: "<feed/>",
    });
    expect(res.status).toBe(200);
    const [, target, raw] = receiveEvent.mock.calls[0];
    expect(target).toEqual({ provider: "websub", externalId: WS });
    expect(raw).toEqual({ signature: "sha1=abc", body: "<feed/>" });
  });
});

describe("POST /routine-events/drive/:id", () => {
  const DR = "dr_" + "c".repeat(32);
  // A tight miss allowance and a loose per-channel one, so a counted miss
  // would show as a refusal long before the channel's own limit does.
  const notify = (state: string, id = DR) => {
    const app = new Hono<AppEnv>();
    app.route("/", routineEvents);
    return app.request(
      `/routine-events/drive/${id}`,
      {
        method: "POST",
        headers: { "X-Goog-Resource-State": state, "X-Goog-Channel-Token": "tok" },
      },
      {
        ...ENV,
        RATE_LIMIT_STANDARD_PER_MINUTE: "3",
        RATE_LIMIT_EXPENSIVE_PER_MINUTE: "100",
      } as never,
    );
  };

  it("hands the channel's token and state to receiveEvent", async () => {
    const res = await notify("change");
    expect(res.status).toBe(200);
    const [, target, raw] = receiveEvent.mock.calls[0];
    expect(target).toEqual({ provider: "google_drive", externalId: DR });
    expect(raw).toEqual({ token: "tok", state: "change" });
  });

  it("acknowledges the channel's first message without a lookup", async () => {
    expect((await notify("sync")).status).toBe(200);
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("answers a channel nobody holds with a 200, and does not count it against Google", async () => {
    receiveEvent.mockResolvedValue({ status: "unknown" });
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await notify("change")).status;
    expect(last).toBe(200);
  });

  it("refuses a wrong token, and an id that is not one of ours", async () => {
    receiveEvent.mockResolvedValueOnce({ status: "forged" });
    expect((await notify("change")).status).toBe(401);
    expect((await notify("change", "dr_short")).status).toBe(404);
  });
});
