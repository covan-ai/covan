import { assertFetchableUrl, assertResolvedHostIsPublic } from "./url-guard";
import { parseFeed, type Cursor, type FeedItem } from "./feed";
import { UpstreamError } from "./upstream-error";

/**
 * Resolve on Node, skip on Workers.
 *
 * There is no DNS API in workerd, and no need for one: the edge will not route
 * to private space. Importing `node:dns` eagerly would break the Workers
 * build, so this is a dynamic import behind a runtime check — and the check
 * fails safe: if `navigator` is missing or shaped unexpectedly, `onWorkers` is
 * `false` and this runtime is treated as Node, i.e. the stricter path.
 *
 * Both of those properties are pinned by `workers-bundle.static.test.ts`. They
 * read like style and are not: a static import here fails `wrangler deploy`,
 * and losing the `navigator` check silently disables the guard on Node, which
 * is the runtime that actually needs it.
 *
 * Exported because every outbound fetch to an address a user chose owes the
 * same check, not only the ones that read a source — a delivery channel's host
 * is user-supplied too, and it is checked again at delivery time because a URL
 * that was public when it was saved can point at `169.254.169.254` a week
 * later.
 */
export async function resolvesPublicly(hostname: string): Promise<void> {
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

/**
 * Reads at most `maxBytes`, so a hostile endpoint cannot exhaust the worker.
 *
 * The cap is enforced as the body arrives and the stream is cancelled the
 * moment it is passed. Reading to the end and slicing afterwards spends the
 * memory first and only then decides it was too much, which is no cap at all.
 */
export async function readCapped(
  // `Pick<Response, "body">` rather than `Response`, so a `Request` satisfies
  // it too. The incoming-webhook route needs exactly this, on exactly the same
  // argument: a body somebody else chose the size of.
  source: Pick<Response, "body">,
  maxBytes: number,
): Promise<string> {
  const reader = source.body?.getReader();
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
 * more than this task's scope. Tracked internally.
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
