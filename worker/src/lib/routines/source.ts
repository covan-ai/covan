import { assertFetchableUrl, assertResolvedHostIsPublic } from "./url-guard";
import { parseFeed, type Cursor, type FeedItem } from "./feed";

/**
 * Resolve on Node, skip on Workers.
 *
 * There is no DNS API in workerd, and no need for one: the edge will not route
 * to private space. Importing `node:dns` eagerly would break the Workers
 * build, so this is a dynamic import behind a runtime check — and the check
 * fails safe: if `navigator` is missing or shaped unexpectedly, `onWorkers` is
 * `false` and this runtime is treated as Node, i.e. the stricter path.
 */
async function resolvesPublicly(hostname: string): Promise<void> {
  const onWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  if (onWorkers) return;
  const { lookup } = await import("node:dns/promises");
  await assertResolvedHostIsPublic(hostname, async (h) => {
    const all = await lookup(h, { all: true });
    return all.map((a) => a.address);
  });
}

export type SourceInput = {
  source_kind: "rss" | "web" | "none";
  source_config: { url?: string };
};

export type FetchDeps = {
  fetchImpl: typeof fetch;
  /** Hosts this service answers on — refuse to fetch ourselves. */
  ownHosts: string[];
  maxBytes?: number;
};

export type SourceResult =
  | { status: "unchanged" }
  | { status: "items"; items: FeedItem[]; etag: string | null }
  | { status: "content"; text: string; hash: string; etag: string | null };

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads at most `maxBytes`, so a hostile endpoint cannot exhaust the worker. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large: over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(joined);
}

/**
 * `redirect: "manual"` is load-bearing: with automatic following, every check
 * in the url guard is bypassed by a single 302.
 *
 * `resolvesPublicly` runs after every `assertFetchableUrl`, including inside
 * the redirect loop — a hop that resolves to link-local space is exactly as
 * dangerous as a starting URL that does, and skipping the check on hops would
 * leave the bypass open through a redirect.
 *
 * Known remainder (not closed here): this validates the address and then lets
 * `fetch` resolve the hostname a second time to actually connect. Between the
 * two lookups, DNS can answer differently — classic rebind. Closing that needs
 * an undici `Agent` with a pinned `connect.lookup` so the socket connects to
 * the address that was actually checked, which changes the fetch call shape
 * more than this task's scope. Tracked in docs/superpowers/backlog.md.
 */
async function guardedFetch(
  rawUrl: string,
  etag: string | null,
  deps: FetchDeps,
): Promise<Response> {
  let target = assertFetchableUrl(rawUrl, deps.ownHosts);
  await resolvesPublicly(target.hostname);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { "User-Agent": "covan-routines/1.0" };
    if (etag && hop === 0) headers["If-None-Match"] = etag;

    const res = await deps.fetchImpl(target.toString(), {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("Location");
      if (!location) throw new Error(`upstream ${res.status} without Location`);
      target = assertFetchableUrl(new URL(location, target).toString(), deps.ownHosts);
      await resolvesPublicly(target.hostname);
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/**
 * A source that answered, but not with content.
 *
 * `transient` is the distinction the executor's pause logic turns on. A 404 or
 * a 403 is a statement about the routine — the feed moved, or we are not
 * allowed to read it — and no amount of retrying changes that. A 429 or a 5xx
 * is a statement about the remote's current mood: Reddit rate-limits
 * datacenter IPs hard enough to fail a healthy routine several ticks in a row,
 * and pausing for that would take a working routine offline until someone
 * noticed and resumed it by hand.
 */
export class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`upstream ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }

  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export async function fetchSource(
  routine: SourceInput,
  cursor: Cursor | null,
  deps: FetchDeps,
): Promise<SourceResult> {
  if (routine.source_kind === "none") {
    return { status: "items", items: [], etag: null };
  }

  const url = routine.source_config.url;
  if (!url) throw new Error("source_config.url is required");

  const res = await guardedFetch(url, cursor?.etag ?? null, deps);

  // The cheap exit most ticks take: nothing changed, so no parse and no LLM.
  if (res.status === 304) return { status: "unchanged" };
  if (!res.ok) throw new UpstreamError(res.status);

  const body = await readCapped(res, deps.maxBytes ?? MAX_BYTES);
  const etag = res.headers.get("ETag");

  if (routine.source_kind === "rss") {
    return { status: "items", items: parseFeed(body), etag };
  }

  const hash = await sha256Hex(body);
  if (cursor?.contentHash === hash) return { status: "unchanged" };
  return { status: "content", text: body, hash, etag };
}
