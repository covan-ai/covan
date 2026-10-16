import { describe, expect, it, vi } from "vitest";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { EventSourceError } from "./errors";
import {
  LEASE_SECONDS,
  WEBSUB_HOOK_ID,
  discoverHub,
  intentToken,
  isOurIntent,
  resolveChannelId,
  websubAdapter,
} from "./websub";

// `postPublicForm` and `fetchPublicText` check what a name resolves to on
// Node; a fixed public answer keeps these tests off the network, as in
// `source.test.ts`.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const ENV = {
  ROUTINE_SECRET_KEY: "k".repeat(32),
  WORKER_HOST: "api.example.com",
  ALLOWED_ORIGIN: "https://app.example.com",
} as never;

const CHANNEL = "UC" + "x".repeat(22);
const TOPIC = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL}`;
const NOW = Date.parse("2026-10-16T12:00:00Z");

function ctx(type: string, over: Partial<SubscriptionRow> = {}, secret: string | null = null) {
  const def = CATALOGUE.eventType(type);
  if (!def) throw new Error(type);
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "websub",
      event_type: type,
      config: {},
      external_id: null,
      secret_ciphertext: null,
      state: {},
      status: "pending",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: def,
    secret,
  } satisfies AdapterContext;
}

/** A fetch that answers each call in turn and remembers what it was asked. */
function scripted(...answers: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    // Where the request was meant to go. On a Bun that pins (`pinnedRequest`)
    // the URL holds the checked address and the name travels in `Host`.
    const host = new Headers(init?.headers).get("Host");
    const asked = new URL(String(url));
    if (host) asked.host = host;
    calls.push({ url: asked.toString(), init });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function formOf(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

const entry = (id: string, published: string) =>
  `<entry><id>yt:video:${id}</id><title>Video ${id}</title>` +
  `<link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>` +
  `<published>${published}</published></entry>`;
const feed = (...entries: string[]) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;

async function signed(body: string, secret: string, algorithm = "SHA-1", prefix = "sha1") {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return {
    body,
    signature: `${prefix}=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  };
}

describe("the callback's own proof", () => {
  it("answers for the topic it was made for and no other", async () => {
    const token = await intentToken(ENV, "ws_1", TOPIC);
    expect(await isOurIntent(ENV, "ws_1", TOPIC, token)).toBe(true);
    expect(await isOurIntent(ENV, "ws_1", `${TOPIC}x`, token)).toBe(false);
    expect(await isOurIntent(ENV, "ws_2", TOPIC, token)).toBe(false);
    expect(await isOurIntent(ENV, "ws_1", TOPIC, "")).toBe(false);
  });
});

describe("resolveChannelId", () => {
  it("takes an id or a /channel/ link as it is, without a fetch", async () => {
    const { fetchImpl } = scripted();
    expect(await resolveChannelId(CHANNEL, fetchImpl)).toBe(CHANNEL);
    expect(
      await resolveChannelId(`https://www.youtube.com/channel/${CHANNEL}/videos`, fetchImpl),
    ).toBe(CHANNEL);
  });

  it("reads an @handle's id off the channel's page", async () => {
    const page = `<html><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}"></html>`;
    const { calls, fetchImpl } = scripted(new Response(page));
    expect(await resolveChannelId("@acme", fetchImpl)).toBe(CHANNEL);
    expect(calls[0].url).toBe("https://www.youtube.com/@acme");
  });

  it("refuses anything that is not a YouTube channel, with a sentence", async () => {
    const { fetchImpl } = scripted(new Response("<html>nothing</html>"));
    await expect(resolveChannelId("https://example.com/@acme", fetchImpl)).rejects.toThrow(
      EventSourceError,
    );
    await expect(resolveChannelId("youtube.com/watch?v=1", fetchImpl)).rejects.toThrow(
      EventSourceError,
    );
    await expect(resolveChannelId("@nobody", fetchImpl)).rejects.toThrow(
      /Couldn't find that YouTube channel/,
    );
  });
});

describe("discoverHub", () => {
  it("finds an Atom feed's hub and its own address", () => {
    const xml = `<feed><link rel="hub" href="https://hub.example.com/"/><link href="https://e.com/feed" rel="self"/></feed>`;
    expect(discoverHub(xml, "https://e.com/alias")).toEqual({
      hub: "https://hub.example.com/",
      topic: "https://e.com/feed",
    });
  });

  it("finds an RSS feed's atom:link hub, and falls back on the pasted URL", () => {
    const xml = `<rss><channel><atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/></channel></rss>`;
    expect(discoverHub(xml, "https://e.com/rss")).toEqual({
      hub: "https://pubsubhubbub.appspot.com/",
      topic: "https://e.com/rss",
    });
  });

  it("finds nothing in a feed that names no hub", () => {
    expect(discoverHub(`<rss><channel><link>https://e.com</link></channel></rss>`, "x")).toBeNull();
  });
});

describe("websubAdapter", () => {
  it("is offered only where the API has a public name for the hub to call", () => {
    const adapter = websubAdapter();
    expect(adapter.isConfigured(ENV)).toBe(true);
    expect(adapter.isConfigured({ ...(ENV as object), WORKER_HOST: undefined } as never)).toBe(
      false,
    );
  });

  it("subscribes a channel at Google's hub, with a callback that proves itself", async () => {
    const { calls, fetchImpl } = scripted(new Response(null, { status: 202 }));
    const adapter = websubAdapter({ fetchImpl, now: () => NOW });
    const result = await adapter.subscribe(
      ctx("youtube.new_video", { config: { channel: CHANNEL } }),
    );

    expect(result.externalId).toMatch(WEBSUB_HOOK_ID);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.state).toEqual({
      topic: TOPIC,
      hub: "https://pubsubhubbub.appspot.com/subscribe",
      channelId: CHANNEL,
    });
    expect(result.expiresAt).toEqual(new Date(NOW + LEASE_SECONDS * 1000));

    expect(calls[0].url).toBe("https://pubsubhubbub.appspot.com/subscribe");
    const form = formOf(calls[0].init);
    expect(form.get("hub.mode")).toBe("subscribe");
    expect(form.get("hub.topic")).toBe(TOPIC);
    expect(form.get("hub.secret")).toBe(result.secret);
    const callback = new URL(form.get("hub.callback")!);
    expect(callback.origin).toBe("https://api.example.com");
    expect(callback.pathname).toBe(`/routine-events/websub/${result.externalId}`);
    expect(await isOurIntent(ENV, result.externalId!, TOPIC, callback.searchParams.get("t")!)).toBe(
      true,
    );
  });

  it("renews with the same callback, secret and topic, without looking anything up again", async () => {
    const { calls, fetchImpl } = scripted(new Response(null, { status: 204 }));
    const adapter = websubAdapter({ fetchImpl, now: () => NOW });
    const id = "ws_" + "b".repeat(32);
    const state = { topic: TOPIC, hub: "https://pubsubhubbub.appspot.com/subscribe" };
    const result = await adapter.renew!(
      ctx("youtube.new_video", { external_id: id, state, status: "active" }, "kept"),
    );
    expect(result).toMatchObject({ externalId: id, secret: "kept", state });
    expect(calls).toHaveLength(1);
    expect(formOf(calls[0].init).get("hub.secret")).toBe("kept");
  });

  it("calls a hub's 4xx a refusal with a sentence, and anything else worth another try", async () => {
    const refusing = websubAdapter({
      fetchImpl: scripted(new Response("bad topic", { status: 400 })).fetchImpl,
    });
    await expect(
      refusing.subscribe(ctx("youtube.new_video", { config: { channel: CHANNEL } })),
    ).rejects.toThrow(EventSourceError);
    const down = websubAdapter({
      fetchImpl: scripted(new Response("", { status: 503 })).fetchImpl,
    });
    const err = await down
      .subscribe(ctx("youtube.new_video", { config: { channel: CHANNEL } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EventSourceError);
  });

  it("finds a feed's hub, and says so plainly when it has none", async () => {
    const withHub = `<feed><link rel="hub" href="https://hub.example.com/"/><link rel="self" href="https://e.com/feed"/></feed>`;
    const { calls, fetchImpl } = scripted(
      new Response(withHub),
      new Response(null, { status: 202 }),
    );
    const result = await websubAdapter({ fetchImpl }).subscribe(
      ctx("rss.new_item", { config: { url: "https://e.com/feed" } }),
    );
    expect(result.state).toEqual({ hub: "https://hub.example.com/", topic: "https://e.com/feed" });
    expect(calls[1].url).toBe("https://hub.example.com/");

    const plain = scripted(new Response("<rss><channel></channel></rss>"));
    await expect(
      websubAdapter({ fetchImpl: plain.fetchImpl }).subscribe(
        ctx("rss.new_item", { config: { url: "https://e.com/rss" } }),
      ),
    ).rejects.toThrow(/doesn't support instant updates/);
  });

  it("refuses a hub at a private address", async () => {
    const xml = `<feed><link rel="hub" href="http://169.254.169.254/"/></feed>`;
    const { fetchImpl } = scripted(new Response(xml));
    await expect(
      websubAdapter({ fetchImpl }).subscribe(
        ctx("rss.new_item", { config: { url: "https://e.com/feed" } }),
      ),
    ).rejects.toThrow(EventSourceError);
  });

  it("unsubscribes at the hub, and shrugs if the hub is down", async () => {
    const { calls, fetchImpl } = scripted(new Response("", { status: 500 }));
    const state = { topic: TOPIC, hub: "https://pubsubhubbub.appspot.com/subscribe" };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await websubAdapter({ fetchImpl }).unsubscribe(
      ctx("youtube.new_video", { external_id: "ws_" + "c".repeat(32), state }, "kept"),
    );
    error.mockRestore();
    expect(formOf(calls[0].init).get("hub.mode")).toBe("unsubscribe");
  });

  it("accepts the hub's signature in whichever algorithm it chose", async () => {
    const adapter = websubAdapter();
    const c = ctx("youtube.new_video", {}, "kept");
    const body = feed(entry("a", "2026-10-16T11:00:00Z"));
    expect(await adapter.authenticate!(await signed(body, "kept"), c)).toBe(true);
    expect(await adapter.authenticate!(await signed(body, "kept", "SHA-256", "sha256"), c)).toBe(
      true,
    );
    expect(await adapter.authenticate!(await signed(body, "other"), c)).toBe(false);
    expect(await adapter.authenticate!({ body, signature: "md5=abc" }, c)).toBe(false);
    expect(await adapter.authenticate!({ body, signature: "" }, c)).toBe(false);
  });

  it("describes new videos and leaves out an old one that was only edited", async () => {
    const adapter = websubAdapter({ now: () => NOW });
    const c = ctx("youtube.new_video", {}, "kept");
    const fresh = await adapter.normalize(
      { body: feed(entry("a", "2026-10-16T11:00:00Z")), signature: "" },
      c,
    );
    expect(fresh?.eventId).toMatch(/^youtube:[0-9a-f]{32}$/);
    expect(fresh?.label).toBe("YouTube · Video a");
    expect(fresh?.text).toContain("https://www.youtube.com/watch?v=a");

    const again = await adapter.normalize(
      { body: feed(entry("a", "2026-10-16T11:00:00Z")), signature: "" },
      c,
    );
    expect(again?.eventId).toBe(fresh?.eventId);

    const old = await adapter.normalize(
      { body: feed(entry("b", "2025-01-01T00:00:00Z")), signature: "" },
      c,
    );
    expect(old).toBeNull();
  });
});
