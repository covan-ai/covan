/**
 * The addresses inbound mail arrives at, and what each one proves.
 *
 * Two kinds, both on `INBOUND_EMAIL_DOMAIN`:
 *
 *   r-<run><mac>@domain      the Reply-To on a routine's emailed report. The
 *                            run is the report's own `routine_runs.id`; the MAC
 *                            (`ROUTINE_SECRET_KEY`, domain-separated) is what
 *                            stops anybody from writing one for a run they
 *                            never received. Nothing is stored to make it.
 *   <name>-<token>@domain    a routine's own address (`email.received`). The
 *                            token is the event subscription's `external_id`,
 *                            random; the name in front is only there so a
 *                            person can tell two addresses apart.
 *
 * WHY LOWERCASE HEX AND A-Z0-9. A local part is meant to be case-sensitive and
 * almost nothing treats it so: mail clients, forwarders and people retyping an
 * address change case freely. Every token here survives being lowercased, and
 * is compared lowercased.
 *
 * WHY THE MAC IS SHORT. Sixty-four bits, as sixteen hex characters, so the
 * whole reply address fits comfortably inside the 64-character limit on a
 * local part. A guess has to be sent as a signed Resend delivery from an
 * authenticated domain, by the routine's own delivery address, under a rate
 * limit — sixty-four bits is a great deal more than that needs.
 */

import { hmacSha256Hex, timingSafeEqual } from "../hmac";

type InboundEnv = { INBOUND_EMAIL_DOMAIN?: string; RESEND_INBOUND_WEBHOOK_SECRET?: string };

/**
 * The receiving domain, lowercased, or null where inbound mail is off. Both
 * variables or neither: a domain with no secret would put a Reply-To on every
 * report that nothing here can receive.
 */
export function inboundDomain(env: InboundEnv): string | null {
  const domain = env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, "");
  return domain && env.RESEND_INBOUND_WEBHOOK_SECRET ? domain : null;
}

const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

async function replyMac(secretKey: string, runId: string): Promise<string> {
  return (await hmacSha256Hex(secretKey, `covan/reply-to/v1\n${runId.toLowerCase()}`)).slice(0, 16);
}

/** The local part of a report's Reply-To, for the run that report came from. */
export async function replyLocalPart(secretKey: string, runId: string): Promise<string> {
  const m = runId.match(UUID);
  if (!m) throw new Error("a reply address needs the run's uuid");
  return `r-${m.slice(1).join("").toLowerCase()}${await replyMac(secretKey, runId)}`;
}

/** The run a reply address was made for, or null when it was not made here. */
export async function runOfReply(secretKey: string, localPart: string): Promise<string | null> {
  const m = localPart.toLowerCase().match(/^r-([0-9a-f]{32})([0-9a-f]{16})$/);
  if (!m || !secretKey) return null;
  const h = m[1];
  const runId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return timingSafeEqual(await replyMac(secretKey, runId), m[2]) ? runId : null;
}

/** A routine's own token: sixteen of a-z0-9, about 82 bits. */
export const AGENT_TOKEN = /^[a-z0-9]{16}$/;

export function newAgentToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 is the largest multiple of 36 under 256, so every character is equally likely.
  const out: string[] = [];
  while (out.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 252 && out.length < 16) out.push(alphabet[b % 36]);
    }
  }
  return out.join("");
}

/** "Weekly sales digest" → "weekly-sales-digest", for the readable half. */
export function addressName(name: string): string {
  // NFKD splits most accented letters into a base and a mark; a few letters
  // are their own letter and do not split, so they are spelled out first.
  const slug = name
    .replace(/[ıİ]/g, "i")
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .replace(/ß/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return slug || "routine";
}

/** A routine's own address. */
export function agentAddress(domain: string, name: string, token: string): string {
  return `${addressName(name)}-${token}@${domain}`;
}

/** The token at the end of a routine's own address, or null. */
export function tokenOfAgentLocalPart(localPart: string): string | null {
  const token = localPart.toLowerCase().split("-").pop() ?? "";
  return AGENT_TOKEN.test(token) ? token : null;
}

/** The bare address in `"Ayşe Demir" <ayse@example.com>`, lowercased. */
export function addressOf(value: string): string {
  const angled = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

/** The local parts, each once, of the addresses on `domain` among `addresses`. */
export function localPartsOn(domain: string, addresses: string[]): string[] {
  const found = new Set<string>();
  for (const value of addresses) {
    const address = addressOf(value);
    const at = address.lastIndexOf("@");
    if (at > 0 && address.slice(at + 1) === domain) found.add(address.slice(0, at));
  }
  return [...found];
}
