/**
 * Mail Resend received for us: proving the delivery is Resend's, reading the
 * message it is about, and deciding what of it a routine should read.
 *
 * Resend's `email.received` webhook carries the envelope only — sender,
 * recipients, subject, the message id — and not the body or the headers, so
 * every delivery is followed by one read of `GET /emails/receiving/{id}`. That
 * read is also where the receiving server's SPF, DKIM and DMARC verdicts are,
 * which is what stands between a routine and anybody who can type somebody
 * else's address into a From line (`passesAuthentication`).
 */

import { verifySvixSignature, type WebhookCheck, type WebhookHeaders } from "../composio/webhook";

/**
 * Resend's signing secret is Svix's: `whsec_` and the key in base64. Decoded,
 * unlike Composio's, because that is what Svix's libraries — which Resend's
 * docs point to — do with it.
 */
export async function verifyResendWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  now = Date.now(),
): Promise<WebhookCheck> {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  let key: Uint8Array;
  try {
    const raw = atob(secret.trim().replace(/^whsec_/, ""));
    key = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  } catch {
    return { ok: false, reason: "webhook secret is not base64" };
  }
  return verifySvixSignature(key, headers, body, now);
}

export type Verdict = "pass" | "fail" | "gray" | "processing_failed" | "unknown";

/** A received message, as `GET /emails/receiving/{id}` answers it, narrowed. */
export type ReceivedEmail = {
  id: string;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** Lowercased names. */
  headers: Record<string, string>;
  authentication: { spf: Verdict; dkim: Verdict; dmarc: Verdict } | null;
  createdAt: string;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : str(value) ? [str(value)] : [];
}

/** Headers as an object of lowercased names, whichever shape they came in. */
function headersOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const h of value) {
      const r = h as { name?: unknown; key?: unknown; value?: unknown };
      const name = str(r?.name ?? r?.key).toLowerCase();
      if (name) out[name] = str(r?.value);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.toLowerCase()] = Array.isArray(v) ? v.map(str).join(", ") : str(v);
    }
  }
  return out;
}

function verdictOf(value: unknown): Verdict {
  const v = str(
    typeof value === "object" && value ? (value as { result?: unknown }).result : value,
  );
  return (["pass", "fail", "gray", "processing_failed"] as const).find((x) => x === v) ?? "unknown";
}

/** HTML to readable text, roughly — for a message that came with no text part. */
function textOfHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseReceivedEmail(body: unknown): ReceivedEmail | null {
  const r = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!r || !str(r.id)) return null;
  const auth =
    r.authentication && typeof r.authentication === "object"
      ? (r.authentication as Record<string, unknown>)
      : null;
  const html = str(r.html);
  return {
    id: str(r.id),
    messageId: str(r.message_id),
    from: str(r.from),
    to: list(r.to),
    subject: str(r.subject),
    text: str(r.text) || (html ? textOfHtml(html) : ""),
    headers: headersOf(r.headers),
    authentication: auth
      ? { spf: verdictOf(auth.spf), dkim: verdictOf(auth.dkim), dmarc: verdictOf(auth.dmarc) }
      : null,
    createdAt: str(r.created_at),
  };
}

/** The ids Resend gives a received email: a uuid. Checked before it reaches a URL. */
export const RECEIVED_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * One received message, in full. Throws on anything but a 2xx, so the route
 * answers Resend with an error and Resend delivers again later.
 */
export async function fetchReceivedEmail(
  apiKey: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReceivedEmail> {
  if (!RECEIVED_ID.test(id)) throw new Error("not a received email id");
  const res = await fetchImpl(`https://api.resend.com/emails/receiving/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`resend answered ${res.status} for received email ${id}`);
  const email = parseReceivedEmail(await res.json());
  if (!email) throw new Error(`resend sent no email for ${id}`);
  return email;
}

/**
 * Whether the sender's domain vouched for this message. A From line is
 * whatever the sender typed; DKIM or SPF passing for it, and DMARC not
 * failing, is the receiving server saying the domain really sent it. A
 * message with no verdicts at all — Resend has none for older mail — is not
 * trusted, because "nobody checked" is not "it checked out".
 */
export function passesAuthentication(email: ReceivedEmail): boolean {
  const a = email.authentication;
  if (!a || a.dmarc === "fail") return false;
  return a.dmarc === "pass" || a.dkim === "pass" || a.spf === "pass";
}

/**
 * Whether a person wrote this, or a machine answering on their behalf — an
 * out-of-office, a delivery failure, a list. Answering one of those would
 * start the routine again, whose report would be answered again: the loop
 * RFC 3834 exists to stop. Covan's own reports say `Auto-Submitted:
 * auto-generated`, which well-behaved responders already leave alone; this
 * is for the rest.
 */
export function isAutomatic(email: ReceivedEmail): boolean {
  const h = email.headers;
  const submitted = (h["auto-submitted"] ?? "").toLowerCase();
  if (submitted && submitted !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(h["precedence"] ?? "")) return true;
  if (h["list-id"] || h["list-unsubscribe"]) return true;
  if (/^(mailer-daemon|postmaster)@/i.test(email.from.replace(/^.*</, ""))) return true;
  return /^(auto(matic)?[ -]?reply|out of (the )?office|undeliverable|delivery status notification)/i.test(
    email.subject,
  );
}

/**
 * What the sender wrote, without the message they were answering underneath
 * it. Mail clients quote in a handful of ways; each is cut at its first line.
 * Imperfect by nature, and harmless when it misses: the report is in the run's
 * material anyway, so a quote left in is read twice, not misread.
 */
export function newTextOf(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    // Gmail and Apple: "On Thu, 16 Oct 2026 at 09:00, Covan <…> wrote:",
    // sometimes wrapped onto a second line.
    if (/^On .+wrote:\s*$/.test(line) || (/^On .+/.test(line) && /wrote:\s*$/.test(next))) break;
    // Outlook: a rule or "-----Original Message-----", then the old headers.
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{10,}\s*$/.test(line)) break;
    if (/^From: .+/.test(line) && /^(Sent|Date): .+/.test(next)) break;
    // A signature delimiter: what follows is the sender's, not news.
    if (line === "-- ") break;
    if (/^>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
