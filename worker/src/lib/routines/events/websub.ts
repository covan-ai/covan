/**
 * WebSub: a YouTube channel's new video, or a feed's new post, the moment the
 * publisher says so rather than the next time somebody looks.
 *
 * WHAT WEBSUB IS. A publisher that supports it names a hub in its feed. A
 * subscriber asks the hub, once, to POST the feed to a callback URL whenever
 * it changes; the hub checks the subscriber really asked (a GET to the
 * callback with a challenge to echo), and from then on pushes each update,
 * signed with a secret the subscriber chose. YouTube does this for every
 * channel, through Google's hub. Many blogs and podcasts do it too. A feed
 * that names no hub cannot be listened to this way, and is better watched on
 * a schedule, which `POST /routines` already does (`source_kind = 'rss'`).
 *
 * THE CALLBACK PROVES ITSELF. The hub's GET can arrive before the subscribe
 * call has returned, and so before `lifecycle.ts` has written the callback's
 * id to the row. So the GET is answered from the URL alone: the callback
 * carries `t`, an HMAC under `ROUTINE_SECRET_KEY` of its own id and the topic
 * it was made for (`intentToken`), and a challenge is echoed only when the
 * hub's `hub.topic` gives the same MAC. Nobody without the key can make a
 * callback that answers for a topic, and no database read is needed to
 * answer a hub.
 *
 * LEASES. A WebSub subscription runs out — Google's after about ten days at
 * most — so each one asks for five and records when it ends (`expires_at`).
 * The sweeper renews any that end within a day (`claim_event_subscriptions`,
 * 0109), which re-sends the same subscribe with the same callback and secret.
 * A paused routine is simply not renewed: its lease runs out by itself, and
 * Resume subscribes again.
 *
 * WHY THIS NEEDS `WORKER_HOST`. The hub has to be given a URL it can reach,
 * and the subscribe can happen with no request in hand (the sweeper), so the
 * URL cannot be taken from one. A deployment without a public name for its
 * API — a Docker install on a laptop — is not offered these events.
 */

import { z } from "zod";
import type { RoutineEnv } from "../../../types";
import { base64url } from "../../jwt";
import { hmacSha256Hex, timingSafeEqual } from "../../hmac";
import { parseFeed, type FeedItem } from "../feed";
import { fetchPublicText, postPublicForm, readCapped, type FetchDeps } from "../source";
import { ownHostsFrom } from "../url-guard";
import type { AdapterContext, EventAdapter, SubscribeResult } from "./adapter";
import type { EventTypeDef, NormalizedEvent } from "./catalog";
import { EventSourceError } from "./errors";
import { clip, lines, rec, str } from "./text";

/** What the receiving route hands over: the pushed feed, unread, and its signature. */
export type WebSubDelivery = {
  /** `X-Hub-Signature`: `sha1=<hex>`, or sha256/sha384/sha512. */
  signature: string;
  body: string;
};

/** The shape of the id in a WebSub callback URL. The route refuses anything else. */
export const WEBSUB_HOOK_ID = /^ws_[A-Za-z0-9_-]{32}$/;

const YOUTUBE_HUB = "https://pubsubhubbub.appspot.com/subscribe";
const YOUTUBE_TOPIC = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=";
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Asked for on every subscribe and renewal; the hub may grant less. */
export const LEASE_SECONDS = 5 * 24 * 60 * 60;

/**
 * YouTube pushes a video again when its title or description is edited, and
 * an edit to a video from last year is not a new video. Entries published
 * longer ago than this are left out of what the routine reads.
 */
const NEW_ENOUGH_MS = 2 * 24 * 60 * 60 * 1000;

/** The most entries one push is described with. A fat ping can carry dozens. */
const MAX_ENTRIES = 5;

type WebSubState = { topic: string; hub: string; channelId?: string };

// ---- the callback's own proof ---------------------------------------------------

/**
 * The MAC a callback URL carries for the topic it was made for. Prefixed so
 * the key's other use (`secret-box.ts`) can never produce the same string.
 */
export async function intentToken(env: RoutineEnv, id: string, topic: string): Promise<string> {
  return hmacSha256Hex(env.ROUTINE_SECRET_KEY, `covan/websub-intent/v1\n${id}\n${topic}`);
}

/** Whether a hub asking about `topic` at callback `id` is asking about one we made. */
export async function isOurIntent(
  env: RoutineEnv,
  id: string,
  topic: string,
  token: string,
): Promise<boolean> {
  if (!env.ROUTINE_SECRET_KEY || !token) return false;
  return timingSafeEqual(await intentToken(env, id, topic), token);
}

/** `https://api.example.com`, or null where this deployment has no public name. */
function publicOrigin(env: RoutineEnv): string | null {
  const host = env.WORKER_HOST?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? `https://${host}` : null;
}

async function callbackUrl(env: RoutineEnv, id: string, topic: string): Promise<string> {
  const origin = publicOrigin(env);
  if (!origin)
    throw new EventSourceError("This deployment has no public address for the hub to call.");
  return `${origin}/routine-events/websub/${id}?t=${await intentToken(env, id, topic)}`;
}

// ---- finding the topic ----------------------------------------------------------

/**
 * A channel's id from whatever the person pasted: the id itself, a
 * `/channel/UC…` link, or an `@handle` (with or without the link around it),
 * which only the channel's own page can turn into an id.
 */
export async function resolveChannelId(input: string, fetchImpl: typeof fetch): Promise<string> {
  const notFound = new EventSourceError(
    "Couldn't find that YouTube channel. Paste its link, its @handle, or its channel ID (it starts with UC).",
  );
  const value = input.trim();
  if (CHANNEL_ID.test(value)) return value;

  let url: URL;
  try {
    url = new URL(
      value.startsWith("@")
        ? `https://www.youtube.com/${value}`
        : value.includes("://")
          ? value
          : `https://${value}`,
    );
  } catch {
    throw notFound;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) throw notFound;
  const direct = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (direct) return direct[1];
  if (!/^\/(@[^/]+|c\/[^/]+|user\/[^/]+)/.test(url.pathname)) throw notFound;

  // Always youtube.com, whatever was pasted: the host is ours to choose here,
  // so this is not a fetch of an address somebody chose. The cookie skips the
  // consent page YouTube shows a request from a data centre in Europe.
  const res = await fetchImpl(`https://www.youtube.com${url.pathname}`, {
    headers: { "Accept-Language": "en", Cookie: "SOCS=CAI", "User-Agent": "covan-routines/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw notFound;
  const html = await readCapped(res, 4 * 1024 * 1024);
  const found =
    html.match(
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
    ) ?? html.match(/"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]{22})"/);
  if (!found) throw notFound;
  return found[1];
}

/** The `href` of a `<link>` (or `<atom:link>`) whose `rel` is `rel`. */
function linkWithRel(xml: string, rel: string): string | null {
  for (const tag of xml.match(/<(?:atom:)?link\b[^>]*>/gi) ?? []) {
    const relOf = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!relOf || !relOf.split(/\s+/).includes(rel)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) return href.replace(/&amp;/g, "&");
  }
  return null;
}

/**
 * A feed's hub and its own canonical address, which is the topic a hub knows
 * it by — the URL somebody pasted may be a redirect or an alias of it.
 */
export function discoverHub(xml: string, pastedUrl: string): { hub: string; topic: string } | null {
  const hub = linkWithRel(xml, "hub");
  if (!hub) return null;
  return { hub, topic: linkWithRel(xml, "self") ?? pastedUrl };
}

// ---- reading a push ---------------------------------------------------------------

/** The MAC over `body` in the hub's chosen algorithm, as lowercase hex. */
async function hmacHex(algorithm: string, secret: string, body: string): Promise<string | null> {
  const hash = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[
    algorithm
  ];
  if (!hash) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function idOfEntries(prefix: string, items: FeedItem[]): Promise<string> {
  const keys = items
    .map((i) => i.key)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keys));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex.slice(0, 32)}`;
}

function describeEntries(items: FeedItem[]): string {
  return items
    .slice(0, MAX_ENTRIES)
    .map((item) => {
      const head = lines([
        ["Title", item.title || "(untitled)"],
        ["Link", item.link],
        ["Published", item.publishedAt ?? ""],
      ]);
      return item.summary ? `${head}\n\n${clip(item.summary, 1_500)}` : head;
    })
    .join("\n\n---\n\n");
}

// ---- the entries ----------------------------------------------------------------

export type WebSubEventSpec = {
  def: EventTypeDef;
  /** The hub and topic for this config. Called once, when there is no row state yet. */
  locate: (config: Record<string, unknown>, deps: FetchDeps) => Promise<WebSubState>;
  describe: (items: FeedItem[], now: number) => Promise<NormalizedEvent | null>;
};

const REQUIRES = { kind: "none" } as const;

export const WEBSUB_EVENTS: readonly WebSubEventSpec[] = [
  {
    def: {
      id: "youtube.new_video",
      provider: "websub",
      app: "YouTube",
      label: "New video",
      description: "Runs within minutes of a YouTube channel publishing a new video.",
      requires: REQUIRES,
      config: z.object({ channel: z.string().trim().min(1).max(300) }),
      fields: [
        {
          key: "channel",
          label: "Channel",
          kind: "text",
          placeholder: "https://www.youtube.com/@channel",
          help: "The channel's link, its @handle, or its channel ID.",
        },
      ],
      sample: {
        eventId: "sample",
        text: lines([
          ["Title", "How we cut our build time in half"],
          ["Link", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
          ["Published", "2026-10-16T09:00:00+00:00"],
        ]),
      },
    },
    locate: async (config, deps) => {
      const channelId = await resolveChannelId(str(config.channel), deps.fetchImpl);
      return { topic: `${YOUTUBE_TOPIC}${channelId}`, hub: YOUTUBE_HUB, channelId };
    },
    describe: async (items, now) => {
      const fresh = items.filter(
        (i) => !i.publishedAt || now - Date.parse(i.publishedAt) <= NEW_ENOUGH_MS,
      );
      if (fresh.length === 0) return null;
      return {
        eventId: await idOfEntries("youtube", fresh),
        text: describeEntries(fresh),
        label: `YouTube · ${fresh[0].title || "New video"}`.slice(0, 120),
      };
    },
  },
  {
    def: {
      id: "rss.new_item",
      provider: "websub",
      app: "RSS feed",
      label: "New post (instant)",
      description:
        "Runs moments after a feed that supports instant updates (WebSub) publishes something.",
      requires: REQUIRES,
      config: z.object({ url: z.string().trim().url().max(2_000) }),
      fields: [
        {
          key: "url",
          label: "Feed",
          kind: "text",
          placeholder: "https://example.com/feed.xml",
          help: "Only feeds that support instant updates work here. For any other feed, start the routine on a schedule and watch the feed as its source.",
        },
      ],
      sample: {
        eventId: "sample",
        text:
          lines([
            ["Title", "Release 4.2: offline mode"],
            ["Link", "https://example.com/blog/release-4-2"],
            ["Published", "2026-10-16T08:30:00+00:00"],
          ]) +
          "\n\nOffline mode is here: everything you opened in the last week now works on a plane.",
      },
    },
    locate: async (config, deps) => {
      const url = str(config.url);
      let xml: string;
      try {
        xml = await fetchPublicText(url, deps);
      } catch {
        throw new EventSourceError("Couldn't read that feed. Check the address and try again.");
      }
      const found = discoverHub(xml, url);
      if (!found) {
        throw new EventSourceError(
          "This feed doesn't support instant updates. Start the routine on a schedule and watch the feed as its source instead.",
        );
      }
      return found;
    },
    describe: async (items) => {
      if (items.length === 0) return null;
      return { eventId: await idOfEntries("rss", items), text: describeEntries(items) };
    },
  },
];

function websubSpec(type: string): WebSubEventSpec | undefined {
  return WEBSUB_EVENTS.find((s) => s.def.id === type);
}

// ---- talking to a hub ---------------------------------------------------------------

export type WebSubDeps = { fetchImpl?: typeof fetch; now?: () => number };

function fetchDeps(env: RoutineEnv, deps: WebSubDeps): FetchDeps {
  return { fetchImpl: deps.fetchImpl ?? fetch, ownHosts: ownHostsFrom(env) };
}

/**
 * Subscribe or unsubscribe. A 2xx — 202 for "I will check with your callback",
 * 204 for "done" — is success. A 4xx is the hub refusing this topic, which no
 * retry changes; anything else may pass.
 */
async function askHub(
  env: RoutineEnv,
  state: WebSubState,
  form: Record<string, string>,
  deps: WebSubDeps,
): Promise<void> {
  let res: Response;
  try {
    res = await postPublicForm(state.hub, form, fetchDeps(env, deps));
  } catch (err) {
    // The guard refusing the hub's address (`url-guard.ts` says "unsafe url")
    // is the feed's doing, not a blip a retry would get past.
    if (err instanceof Error && err.message.startsWith("unsafe url")) {
      throw new EventSourceError("This feed's hub is not at an address Covan may call.");
    }
    throw err;
  }
  if (res.ok) return;
  const said = (await res.text().catch(() => "")).trim().slice(0, 200);
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new EventSourceError(
      `The feed's hub refused the subscription${said ? `: ${said}` : "."}`,
    );
  }
  throw new Error(`websub hub answered ${res.status}${said ? `: ${said}` : ""}`);
}

function stateOf(ctx: AdapterContext): WebSubState | null {
  const s = rec(ctx.subscription.state);
  return s && typeof s.topic === "string" && typeof s.hub === "string"
    ? {
        topic: s.topic,
        hub: s.hub,
        channelId: typeof s.channelId === "string" ? s.channelId : undefined,
      }
    : null;
}

function newCallbackId(): string {
  return `ws_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function websubAdapter(deps: WebSubDeps = {}): EventAdapter {
  const now = deps.now ?? Date.now;

  // Subscribe, renew and resume are one call: the same callback, secret and
  // topic once there are any, so a renewal is the hub hearing the request it
  // already holds again, and a retry after a failure never leaves a second
  // subscription at the hub pushing to an id nobody holds.
  const subscribe = async (ctx: AdapterContext): Promise<SubscribeResult> => {
    const spec = websubSpec(ctx.subscription.event_type);
    if (!spec) throw new EventSourceError("This event can no longer be listened for.");
    const kept = stateOf(ctx);
    const state =
      kept ?? (await spec.locate(ctx.subscription.config ?? {}, fetchDeps(ctx.env, deps)));
    const id = (kept && ctx.subscription.external_id) || newCallbackId();
    const secret = (kept && ctx.secret) || newSecret();
    await askHub(
      ctx.env,
      state,
      {
        "hub.mode": "subscribe",
        "hub.topic": state.topic,
        "hub.callback": await callbackUrl(ctx.env, id, state.topic),
        "hub.secret": secret,
        "hub.lease_seconds": String(LEASE_SECONDS),
        "hub.verify": "async",
      },
      deps,
    );
    return {
      externalId: id,
      secret,
      state,
      expiresAt: new Date(now() + LEASE_SECONDS * 1000),
    };
  };

  return {
    provider: "websub",
    isConfigured: (env) => Boolean(publicOrigin(env) && env.ROUTINE_SECRET_KEY),
    subscribe,
    renew: subscribe,

    // Told, so the hub stops pushing to a URL that now answers 404. Not
    // required: a lease nobody renews ends by itself within days.
    async unsubscribe(ctx) {
      const state = stateOf(ctx);
      const id = ctx.subscription.external_id;
      if (!state || !id) return;
      try {
        await askHub(
          ctx.env,
          state,
          {
            "hub.mode": "unsubscribe",
            "hub.topic": state.topic,
            "hub.callback": await callbackUrl(ctx.env, id, state.topic),
          },
          deps,
        );
      } catch (err) {
        console.error(`websub unsubscribe for ${ctx.routine.id} failed; the lease will lapse`, err);
      }
    },

    // A hub cannot be told to hold its pushes. Paused, the lease is left to
    // run out — a push meanwhile is refused in `receive.ts` — and resuming is
    // a fresh lease.
    async setEnabled(ctx, enabled) {
      if (enabled) return subscribe(ctx);
    },

    async authenticate(raw, ctx) {
      const delivery = rec(raw) as WebSubDelivery | null;
      if (!ctx.secret || !delivery || typeof delivery.body !== "string") return false;
      const [algorithm, mac] = str(delivery.signature).split("=", 2);
      if (!algorithm || !mac) return false;
      const expected = await hmacHex(algorithm.toLowerCase(), ctx.secret, delivery.body);
      return expected !== null && timingSafeEqual(expected, mac.toLowerCase());
    },

    async normalize(raw, ctx) {
      const spec = websubSpec(ctx.subscription.event_type);
      const delivery = rec(raw) as WebSubDelivery | null;
      if (!spec || !delivery) return null;
      let items: FeedItem[];
      try {
        items = parseFeed(delivery.body);
      } catch {
        return null;
      }
      return spec.describe(items, now());
    },
  };
}

export const WEBSUB_ADAPTER = websubAdapter();
