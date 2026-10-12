/**
 * The egress to pin a new cookie jar to, from a request's `CF-IPCountry`.
 *
 * Cloudflare puts the request's country on `cf`, and `CF-IPCountry` carries it
 * too. It is the right value rather than a convenient one: spec §1 pins the
 * egress once and reuses it forever, because cookies are bound to the egress
 * they were set from — so the egress should be where the person actually is,
 * which makes the sign-in's risk signals look ordinary to the site and makes
 * every later task arrive from the same place.
 *
 * Shared by the two doors a jar is made through: the takeover route, and the
 * first `browse` a person approves (ruling R19), which reads it off the chat
 * request through `ToolContext.egressCountry`. Until 2026-10-12 only the first
 * door pinned anything, so every jar made by a run was left to the provider's
 * default — a US residential IP — and a LinkedIn account used from Istanbul
 * was driven from somewhere in America.
 *
 * `T1` and `XX` are Cloudflare's own answers for Tor and for "could not tell",
 * and neither is a country to pin anything to. Null then, which leaves the
 * provider to choose — no worse than the unpinned behaviour this replaces.
 *
 * **Lowercased, and `gb` rewritten.** browser-use's `proxyCountryCode` is a
 * 248-value lowercase enum, and it is not quite ISO 3166-1: the United
 * Kingdom is spelled `uk` there, where `CF-IPCountry` says `GB`. Sent
 * unmapped it is a 422 on every takeover from the UK — a whole country
 * unable to sign in to anything, with "could not open a browser for you" as
 * the only symptom.
 *
 * **And the four it has no proxy in at all, dropped.** `cn`, `ax`, `io` and
 * `um` are not aliases but countries the enum lacks (checked against
 * `/api/v4/openapi.json` on 2026-10-12). `openTakeover` drops a refused pin
 * and retries, but a run has no such retry: a jar pinned to one of these
 * would be a 422 on every task its owner ever asked for. Pinned to nothing
 * instead, which is a jar that works.
 */
const PROVIDER_SPELLING: Record<string, string> = { gb: "uk" };
const NO_PROXY_THERE = new Set(["cn", "ax", "io", "um"]);

export function egressCountry(header: string | undefined | null): string | null {
  if (!header || header === "XX" || header === "T1") return null;
  const code = header.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  if (NO_PROXY_THERE.has(code)) return null;
  return PROVIDER_SPELLING[code] ?? code;
}
