import { assertFetchableUrl, assertResolvedHostIsPublic } from "./url-guard";
import { parseFeed, type Cursor, type FeedItem } from "./feed";
import { UpstreamError } from "./upstream-error";

/**
 * Resolve on Node, skip on Workers — and, where the runtime allows it, name
 * the address to connect to.
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
 * Checking an answer is only half of it. `fetch` resolves the name again to
 * connect, and a name whose owner answers "public" to the first lookup and
 * "169.254.169.254" to the second walks through — DNS rebinding. So on Bun,
 * which is what the Docker image runs, this returns the address it checked,
 * and `pinnedRequest` connects to exactly that. Elsewhere it returns null: on
 * Workers there is nothing to pin, and plain Node's fetch — like Bun before
 * `PINNING_BUN` — cannot be told which name to verify the certificate against,
 * so pinning there would break every https request. Those keep the check
 * without the pin.
 *
 * Exported because every outbound fetch to an address a user chose owes the
 * same check, not only the ones that read a source — a delivery channel's host
 * is user-supplied too, and it is checked again at delivery time because a URL
 * that was public when it was saved can point at `169.254.169.254` a week
 * later.
 */
export async function resolvesPublicly(hostname: string): Promise<string | null> {
  const onWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  if (onWorkers) return null;
  const { lookup } = await import("node:dns/promises");
  const addresses = await assertResolvedHostIsPublic(hostname, async (h) => {
    const all = await lookup(h, { all: true });
    return all.map((a) => a.address);
  });
  return canPin() ? (addresses[0] ?? null) : null;
}

/**
 * The first Bun whose fetch takes the TLS server name from the request rather
 * than from the address it connects to — measured, not read: 1.3.0 refuses a
 * pinned https request with ERR_TLS_CERT_ALTNAME_INVALID, 1.3.14 verifies it
 * against the name. Pinning on an older Bun would break every https fetch, so
 * it falls back to checking without pinning, as plain Node does.
 */
const PINNING_BUN = ">=1.3.14";

function canPin(): boolean {
  const bun = (
    globalThis as {
      Bun?: { version: string; semver: { satisfies(version: string, range: string): boolean } };
    }
  ).Bun;
  return bun ? bun.semver.satisfies(bun.version, PINNING_BUN) : false;
}

/**
 * The URL and init that make `fetch` connect to `address` while speaking to
 * `target`'s host: the address in the URL, the real name in `Host`, and, for
 * https, the real name as the TLS server name — which Bun's fetch uses for SNI
 * and to check the certificate, so a pinned request is verified against the
 * name somebody chose rather than against the address.
 *
 * With no address (Workers, plain Node, a mock) it is the request unchanged.
 */
export function pinnedRequest(
  target: URL,
  address: string | null | undefined,
  init: RequestInit,
): [string, RequestInit] {
  if (!address || isIpLiteral(target.hostname)) return [target.toString(), init];
  const pinned = new URL(target);
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set("Host", target.host);
  const tls = target.protocol === "https:" ? { tls: { serverName: target.hostname } } : {};
  return [pinned.toString(), { ...init, headers, ...tls } as RequestInit];
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
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
 * leave the bypass open through a redirect. Each hop connects to the address
 * its own check approved (`pinnedRequest`).
 */
async function guardedFetch(
  rawUrl: string,
  etag: string | null,
  deps: FetchDeps,
): Promise<Response> {
  let target = assertFetchableUrl(rawUrl, deps.ownHosts);
  let address = await resolvesPublicly(target.hostname);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { "User-Agent": "covan-routines/1.0" };
    if (etag && hop === 0) headers["If-None-Match"] = etag;

    const res = await deps.fetchImpl(
      ...pinnedRequest(target, address, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("Location");
      if (!location) throw new Error(`upstream ${res.status} without Location`);
      target = assertFetchableUrl(new URL(location, target).toString(), deps.ownHosts);
      address = await resolvesPublicly(target.hostname);
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

/**
 * A page somebody chose, read under the same guard a source is: a public
 * address only, at most three redirects, each one checked again, the body
 * capped. For the event side, which reads a feed once to learn where its
 * WebSub hub is (`events/websub.ts`) and has no cursor or etag to bring.
 */
export async function fetchPublicText(url: string, deps: FetchDeps): Promise<string> {
  const res = await guardedFetch(url, null, deps);
  if (!res.ok) throw new UpstreamError(res.status);
  return readCapped(res, deps.maxBytes ?? MAX_BYTES);
}

/**
 * A form POST to an address somebody chose — a WebSub hub a feed named — under
 * the same guard, and refusing to follow a redirect at all: a hub that
 * answers a subscription with one is not behaving like a hub, and a POST
 * re-sent to wherever it points is how a guard is walked around.
 */
export async function postPublicForm(
  url: string,
  form: Record<string, string>,
  deps: FetchDeps,
): Promise<Response> {
  const target = assertFetchableUrl(url, deps.ownHosts);
  const address = await resolvesPublicly(target.hostname);
  return deps.fetchImpl(
    ...pinnedRequest(target, address, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "covan-routines/1.0",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}
