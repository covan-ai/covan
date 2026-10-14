import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { decryptSecret } from "../secret-box";
import { canSendEmail, sendEmail, type Email } from "../email";
import { emailShell } from "../email-layout";
import { paragraphs } from "../emails/prose";
import { base64url } from "../jwt";
import type { DeliveryChannel, DeliveryKind } from "./delivery";

/**
 * An email delivery channel sends only to an address that has said yes (0096).
 *
 * A channel took any address, and the routine engine mailed it under Covan's
 * name — a digest, a test, a "paused" or "waiting on credits" notice — with a
 * subject the routine's owner wrote. Any free account could aim that at
 * anybody. So an address is confirmed one of two ways:
 *
 * - **It is the owner's own sign-in address, confirmed at sign-up.** Most
 *   channels are, and asking somebody to confirm the address they signed in
 *   with would be friction for nothing. Checked against `auth.users`, not the
 *   token's claim, and only when GoTrue has `email_confirmed_at` for it.
 * - **Somebody at that address opened the link this module mailed and said
 *   yes.** The mail is fixed text: nothing the owner wrote is in it, so it is
 *   no use for saying anything to a stranger but "somebody wants to send you
 *   routine results — ignore this if that's news".
 *
 * Links are bounded so the question itself is not a way to mail strangers: one
 * per channel a day, and `DAILY_LINKS_PER_OWNER` distinct channels a day per
 * person.
 */

/** How long a link confirms anything. */
export const CONFIRMATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How long before the same channel may be sent another link. */
export const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
/** How many different addresses one person may ask in a day. */
export const DAILY_LINKS_PER_OWNER = 5;

export type ConfirmationOutcome = "sent" | "recently" | "limit" | "unavailable";

/** A row with what this module needs to decide; select exactly these. */
export type ConfirmableChannel = {
  id: string;
  user_id: string;
  kind: string;
  secret_ciphertext: string;
  confirmed_at: string | null;
  confirmation_sent_at: string | null;
};

export const CONFIRMABLE_COLUMNS =
  "id, user_id, kind, secret_ciphertext, confirmed_at, confirmation_sent_at";

/** 32 bytes of CSPRNG, base64url, and the SHA-256 hex the database keeps. */
export async function newConfirmationToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, hash: await hashConfirmationToken(token) };
}

export async function hashConfirmationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** In the fragment, for `inviteUrl`'s reason: it never reaches a server log. */
export function confirmationUrl(appUrl: string, token: string): string {
  return `${appUrl}/confirm-address#token=${encodeURIComponent(token)}`;
}

/**
 * The question, and nothing else. No routine name, no person's name, no
 * workspace: each of those is text somebody chose, and this mail goes to an
 * address that has not agreed to hear from them.
 */
export function confirmationEmail(to: string, url: string): Email {
  return {
    to,
    subject: "Confirm this address for Covan",
    text: [
      "Somebody using Covan asked to send routine results to this address.",
      "",
      "If that was you, or you expect it, open this link and confirm:",
      "",
      `  ${url}`,
      "",
      "If not, ignore this email. Nothing is sent here unless the link is used,",
      "and it stops working in seven days.",
    ].join("\n"),
    html: emailShell({
      preheader: "Somebody asked to send routine results to this address.",
      heading: "Confirm this address",
      bodyHtml: paragraphs(
        "Somebody using Covan asked to send routine results to this address.",
        "If that was you, or you expect it, confirm below. If not, ignore this email: nothing is sent here unless the button is used.",
      ),
      action: { label: "Confirm this address", url },
      footnote: "The link stops working in seven days.",
    }),
  };
}

/**
 * The owner's own sign-in address, lower-cased, if GoTrue has confirmed it.
 *
 * Null when it cannot say, which is the cautious answer: the address is then
 * asked like a stranger's, and an owner who gets a link for their own address
 * has lost nothing.
 */
export async function ownConfirmedAddress(env: RoutineEnv, userId: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient(env).auth.admin.getUserById(userId);
    if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
    return data.user.email.trim().toLowerCase();
  } catch {
    return null;
  }
}

export function sameAddress(a: string, b: string | null): boolean {
  return b !== null && a.trim().toLowerCase() === b;
}

const appUrlOf = (env: RoutineEnv) => (env.ALLOWED_ORIGIN ?? "").split(",")[0].trim();

/**
 * Mail `address` a link that confirms channel `channelId`, unless the limits
 * say not yet. Never throws: a question that could not be asked is an outcome
 * the caller reports, not a failure of what it was doing.
 */
export async function askToConfirm(
  env: RoutineEnv,
  db: SupabaseClient,
  channel: { id: string; user_id: string; confirmation_sent_at: string | null },
  address: string,
  now: Date = new Date(),
): Promise<ConfirmationOutcome> {
  try {
    const last = channel.confirmation_sent_at ? Date.parse(channel.confirmation_sent_at) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < RESEND_AFTER_MS) return "recently";
    if (!canSendEmail(env)) return "unavailable";
    if ((await linksSentToday(db, channel.user_id, now)) >= DAILY_LINKS_PER_OWNER) return "limit";

    const { token, hash } = await newConfirmationToken();
    const { error } = await db
      .from("delivery_channels")
      .update({ confirmation_hash: hash, confirmation_sent_at: now.toISOString() })
      .eq("id", channel.id)
      .is("confirmed_at", null);
    if (error) return "unavailable";

    const res = await sendEmail(confirmationEmail(address, confirmationUrl(appUrlOf(env), token)), {
      fetchImpl: fetch.bind(globalThis),
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM,
    });
    return res.ok ? "sent" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Distinct channels of this person's that were sent a link in the last day. */
export async function linksSentToday(
  db: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count, error } = await db
    .from("delivery_channels")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gt("confirmation_sent_at", new Date(now.getTime() - RESEND_AFTER_MS).toISOString());
  // Unknown counts as full: an error here must not become the way past the cap.
  if (error) return DAILY_LINKS_PER_OWNER;
  return count ?? 0;
}

/**
 * A channel, ready for `deliver`.
 *
 * Anything but an unconfirmed email channel passes straight through. An
 * unconfirmed one addressed to its owner's own confirmed sign-in address is
 * confirmed on the spot — which is how every channel that existed before 0096
 * and was a person's own address carries on without them noticing. Any other
 * is asked (within the limits) and comes back still unconfirmed, which
 * `deliver` refuses with a sentence saying why.
 */
export async function readyForDelivery(
  env: RoutineEnv,
  row: ConfirmableChannel,
  now: Date = new Date(),
): Promise<DeliveryChannel & { asked?: ConfirmationOutcome }> {
  const channel = {
    kind: row.kind as DeliveryKind,
    secret_ciphertext: row.secret_ciphertext,
    confirmed_at: row.confirmed_at,
  };
  if (row.kind !== "email" || row.confirmed_at) return channel;

  const address = (await decryptSecret(row.secret_ciphertext, env.ROUTINE_SECRET_KEY)).trim();
  const db = serviceClient(env);
  if (sameAddress(address, await ownConfirmedAddress(env, row.user_id))) {
    const stamp = now.toISOString();
    await db
      .from("delivery_channels")
      .update({ confirmed_at: stamp, confirmation_hash: null })
      .eq("id", row.id);
    return { ...channel, confirmed_at: stamp };
  }
  return { ...channel, asked: await askToConfirm(env, db, row, address, now) };
}

/**
 * The link's other end: confirm whichever channel this token was minted for,
 * if it is still waiting and the link is under a week old. One update, so a
 * token is used at most once — the hash is cleared in the same statement.
 */
export async function confirmAddress(
  env: RoutineEnv,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const hash = await hashConfirmationToken(token);
  const { data, error } = await serviceClient(env)
    .from("delivery_channels")
    .update({ confirmed_at: now.toISOString(), confirmation_hash: null })
    .eq("confirmation_hash", hash)
    .is("confirmed_at", null)
    .gt("confirmation_sent_at", new Date(now.getTime() - CONFIRMATION_LIFETIME_MS).toISOString())
    .select("id");
  return !error && (data?.length ?? 0) > 0;
}
