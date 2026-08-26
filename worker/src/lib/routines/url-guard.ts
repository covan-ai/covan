/**
 * Guards every outbound fetch to a user-supplied address.
 *
 * Note what this does NOT do: it cannot resolve DNS, so a hostname that
 * resolves to a private address still passes. Cloudflare's edge will not route
 * to RFC1918 space, which covers the gap for the literal cases; the checks
 * here stop the direct attempts and the redirect bounce.
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

const PRIVATE_V6 = ["::1", "::", "0:0:0:0:0:0:0:1"];

/** Hostname only: no port, no trailing root dot, lowercased. */
function canonicalHost(value: string): string {
  const withoutPort = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0];
  return withoutPort.replace(/\.$/, "").toLowerCase();
}

export function isPrivateAddress(host: string): boolean {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const canonicalBare = bare.replace(/\.$/, "").toLowerCase();

  // Check IPv4-mapped IPv6 in hex form
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonicalBare);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    return PRIVATE_V4.some((re) => re.test(dotted));
  }

  // Check IPv4-mapped IPv6 in dotted form
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(canonicalBare);
  if (mappedDotted) return PRIVATE_V4.some((re) => re.test(mappedDotted[1]));

  if (PRIVATE_V6.includes(canonicalBare)) return true;
  if (/^fe80:/i.test(canonicalBare) || /^f[cd][0-9a-f]{2}:/i.test(canonicalBare)) return true;

  // IPv4-compatible IPv6 (::a.b.c.d) and NAT64 (64:ff9b::/96) both carry a v4
  // address in the low bits and both route to it.
  const embedded = /^(?:::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(canonicalBare);
  if (embedded) return PRIVATE_V4.some((re) => re.test(embedded[1]));
  const embeddedHex = /^(?:::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonicalBare);
  if (embeddedHex) {
    const hi = parseInt(embeddedHex[1], 16);
    const lo = parseInt(embeddedHex[2], 16);
    return PRIVATE_V4.some((re) => re.test(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`));
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(canonicalBare))
    return PRIVATE_V4.some((re) => re.test(canonicalBare));
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
