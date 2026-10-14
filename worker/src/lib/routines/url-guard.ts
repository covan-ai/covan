/**
 * Guards every outbound fetch to a user-supplied address.
 *
 * `assertFetchableUrl` below judges the hostname string alone, so a name that
 * merely *resolves* to a private address — `169.254.169.254.nip.io`,
 * `metadata.google.internal`, a bare compose service name — walks straight
 * past it. On Cloudflare that is survivable: the edge will not route to
 * RFC1918 space. It is not survivable on the Node runtime (`worker/src/node.ts`,
 * the Docker image), where `fetch` resolves and connects itself. That gap is
 * `assertResolvedHostIsPublic` below — the resolving half of the guard, wired
 * into the Node fetch path in `source.ts`.
 */

const PRIVATE_V4 = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local — cloud metadata lives here
  /^0\./, // "this network", and 0.0.0.0 as every local address
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT, RFC6598 — carriers and Tailscale
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1
  /^198\.1[89]\./, // benchmarking, RFC2544
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^2(2[4-9]|[3-4]\d|5[0-5])\./, // multicast and reserved, 224.0.0.0/4 upward
];

/** Hostname only: no port, no trailing root dot, lowercased. */
function canonicalHost(value: string): string {
  const withoutPort = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0];
  return withoutPort.replace(/\.$/, "").toLowerCase();
}

/**
 * An IPv6 address as its eight 16-bit groups, or null when it is not one.
 *
 * Parsed rather than pattern-matched, because an address has many spellings —
 * `::ffff:7f00:1`, `::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1` and
 * `::FFFF:7F00:0001` are one address — and a list of patterns is a list of the
 * spellings somebody thought of. A trailing dotted quad is the low 32 bits.
 */
function ipv6Groups(text: string): number[] | null {
  if (!text.includes(":")) return null;
  let body = text;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(body);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((o) => o > 255)) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    body = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === ""
      ? []
      : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

const isPrivateV4 = (dotted: string) => PRIVATE_V4.some((re) => re.test(dotted));
const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Whether an IPv6 address is anywhere a request must not go: loopback,
 * unspecified, link-local (`fe80::/10`, all of it), site-local, unique-local,
 * multicast, documentation, discard-only, and every range that carries an
 * IPv4 address inside it — mapped (`::ffff:0:0/96`), translated
 * (`::ffff:0:0:0/96`), compatible (`::/96`), NAT64 (`64:ff9b::/96`), 6to4
 * (`2002::/16`) — judged by the IPv4 address it carries. The local-use NAT64
 * prefix (`64:ff9b:1::/48`) and Teredo (`2001::/32`) are refused outright: what
 * they reach is decided by somebody else's translator.
 */
function isPrivateV6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(7) && g[7] <= 1) return true; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local, fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local, deprecated
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local, fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if (zeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(v4Of(g[6], g[7])); // mapped
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(v4Of(g[6], g[7])); // translated
  if (zeroUpTo(6)) return isPrivateV4(v4Of(g[6], g[7])); // compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateV4(v4Of(g[6], g[7])); // NAT64
  }
  if (g[0] === 0x2002) return isPrivateV4(v4Of(g[1], g[2])); // 6to4
  return false;
}

export function isPrivateAddress(host: string): boolean {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const canonicalBare = bare.replace(/\.$/, "").toLowerCase();

  const groups = ipv6Groups(canonicalBare.split("%")[0]);
  if (groups) return isPrivateV6(groups);
  if (canonicalBare.includes(":")) return true; // looks like IPv6 and is not one we can read

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(canonicalBare)) return isPrivateV4(canonicalBare);
  return canonicalBare === "localhost";
}

/**
 * The hosts a routine must never be pointed at: the app's own frontend and this
 * worker's own domain. Both the creation path and the execution path must see
 * the same list, or a URL rejected at run time sails through validation at
 * setup — which is the worse place to find out.
 *
 * Tolerant by design. ALLOWED_ORIGIN entries are normally full origins but a
 * bare host is a plausible mistake, and WORKER_HOST is documented as a host
 * rather than a URL; a malformed entry drops out instead of throwing, because
 * throwing here would 500 every routine create and every draft.
 */
export function ownHostsFrom(env: { ALLOWED_ORIGIN: string; WORKER_HOST?: string }): string[] {
  return [...(env.ALLOWED_ORIGIN ?? "").split(","), ...(env.WORKER_HOST ?? "").split(",")]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o.includes("://") ? o : `https://${o}`).host;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function assertFetchableUrl(raw: string, ownHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`unsafe url: not parseable`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsafe url: scheme ${url.protocol} not allowed`);
  }

  const host = canonicalHost(url.hostname);
  if (isPrivateAddress(url.hostname)) {
    throw new Error(`unsafe url: ${url.hostname} is a private address`);
  }

  if (host === "workers.dev" || host.endsWith(".workers.dev")) {
    throw new Error(`unsafe url: ${url.hostname} is a workers.dev host`);
  }

  if (ownHosts.some((h) => canonicalHost(h) === host)) {
    throw new Error(`unsafe url: ${url.host} is this service`);
  }
  return url;
}

/**
 * The second half of the guard, for runtimes that resolve DNS themselves.
 *
 * `assertFetchableUrl` can only judge the hostname it was handed, so
 * `169.254.169.254.nip.io` — or a bare compose service name like `kong` —
 * walks straight past it. On Cloudflare that is survivable because the edge
 * refuses to route to RFC1918 space. On the Node runtime, which is the Docker
 * image and the whole self-host story, `fetch` resolves and connects to
 * whatever comes back, on a network shared with the database.
 *
 * `resolve` is injected rather than imported so this module stays free of
 * `node:dns` — the Workers bundle must not pull it in.
 */
export async function assertResolvedHostIsPublic(
  hostname: string,
  resolve: (host: string) => Promise<string[]>,
): Promise<string[]> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new Error(`unsafe url: ${hostname} does not resolve`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`unsafe url: ${hostname} resolves to ${address}, a private address`);
    }
  }
  return addresses;
}
