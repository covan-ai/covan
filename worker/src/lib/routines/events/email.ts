/**
 * A routine with an address of its own: mail it, and it runs on what you sent.
 *
 * The address is `<name>-<token>@INBOUND_EMAIL_DOMAIN`, the token being this
 * subscription's `external_id` (`lib/inbound-email/address.ts`). It is shown
 * on the routine's page (`GET /routines/:id/event/setup`). Mail reaches it
 * through Resend's inbound webhook, at `POST /email/inbound`, which proves the
 * delivery is Resend's and the sender's domain vouched for the message before
 * this file is asked anything.
 *
 * WHO MAY MAIL IT. An address is easy to leak — it is in a forwarded thread,
 * in a colleague's contacts, in a mailing list's archive — and every message
 * to it is a model call charged to the workspace. So a routine answers only
 * its approved senders: the addresses and `@domains` its owner listed, or,
 * when the list is empty, the members of its workspace. Anybody else's mail
 * is read by nobody and runs nothing (`normalize` answers null).
 *
 * WHY THE SERVICE ROLE. "The members of this workspace" is a question about
 * other people's addresses, which a delivery with no caller can ask only with
 * the service role. It reads `workspace_members` for the routine's own
 * workspace and those members' `profiles.email`, and nothing else.
 */

import { z } from "zod";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import { addressOf, inboundDomain, newAgentToken } from "../../inbound-email/address";
import { isAutomatic, newTextOf, type ReceivedEmail } from "../../inbound-email/resend";
import type { AdapterContext, EventAdapter } from "./adapter";
import type { EventTypeDef } from "./catalog";
import { clip, lines } from "./text";

/** What the receiving route hands over: the message, already read in full. */
export type EmailDelivery = { email: ReceivedEmail };

const sendersConfig = z.object({
  senders: z
    .string()
    .trim()
    .max(2_000)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** "ayse@example.com, acme.com" → ["ayse@example.com", "@acme.com"]. */
export function approvedSenders(config: Record<string, unknown>): string[] {
  const raw = typeof config.senders === "string" ? config.senders : "";
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.includes("@") ? s : `@${s}`))
    .filter((s) => /^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(s));
}

/** Whether `sender` is one of `approved`: an exact address, or any at an `@domain`. */
export function isApproved(sender: string, approved: string[]): boolean {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  return approved.some((a) => (a.startsWith("@") ? a.slice(1) === domain : a === sender));
}

export const EMAIL_RECEIVED: EventTypeDef = {
  id: "email.received",
  provider: "email",
  app: "Email",
  label: "Mail to this routine",
  description: "Gives the routine an email address. Runs when somebody you approve mails it.",
  requires: { kind: "none" },
  config: sendersConfig,
  fields: [
    {
      key: "senders",
      label: "Who may mail it",
      kind: "text",
      optional: true,
      placeholder: "ayse@example.com, @example.com",
      help: "Addresses, or @domains, separated by commas. Empty means the members of this workspace.",
    },
  ],
  sample: {
    eventId: "sample",
    text:
      lines([
        ["From", "Ayşe Demir <ayse@example.com>"],
        ["Subject", "Notes from the supplier call"],
      ]) +
      "\n\nThey can deliver the second batch on the 28th if we confirm by Friday. Price unchanged.",
  },
};

export type EmailAdapterDeps = {
  /** The workspace's members' addresses, lowercased. Injected so a test needs no database. */
  memberAddresses?: (env: RoutineEnv, workspaceId: string) => Promise<string[]>;
};

async function readMemberAddresses(env: RoutineEnv, workspaceId: string): Promise<string[]> {
  const db = serviceClient(env);
  const { data: members, error } = await db
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`could not read the workspace's members: ${error.message}`);
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (ids.length === 0) return [];
  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("email")
    .in("id", ids);
  if (profileError)
    throw new Error(`could not read the members' addresses: ${profileError.message}`);
  return ((profiles ?? []) as Array<{ email: string | null }>)
    .map((p) => (p.email ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/** Covan's own sending address, so a report mailed to a routine is not news to it. */
function ownSender(env: RoutineEnv): string {
  return env.RESEND_FROM ? addressOf(env.RESEND_FROM) : "";
}

export function emailAdapter(deps: EmailAdapterDeps = {}): EventAdapter {
  const memberAddresses = deps.memberAddresses ?? readMemberAddresses;
  return {
    provider: "email",
    isConfigured: (env) => inboundDomain(env) !== null,

    // The token is the address, and the address may already be in somebody's
    // contacts: a row that has one keeps it.
    async subscribe(ctx) {
      return { externalId: ctx.subscription.external_id ?? newAgentToken() };
    },
    // Nothing anywhere else holds the address; with the row gone it is just
    // mail to an address nothing answers.
    async unsubscribe() {},
    async setEnabled() {},

    async normalize(raw, ctx: AdapterContext) {
      const email = (raw as EmailDelivery | null)?.email;
      if (!email) return null;
      const sender = addressOf(email.from);
      const domain = inboundDomain(ctx.env);
      // Mail from this deployment — a routine's report forwarded to another
      // routine's address, an answer bouncing back — is not somebody writing.
      if (!sender || sender === ownSender(ctx.env) || (domain && sender.endsWith(`@${domain}`))) {
        return null;
      }
      if (isAutomatic(email)) return null;

      const listed = approvedSenders(ctx.subscription.config ?? {});
      const approved = listed.length
        ? listed
        : await memberAddresses(ctx.env, ctx.routine.workspace_id);
      if (!isApproved(sender, approved)) return null;

      const body = newTextOf(email.text);
      const header = lines([
        ["From", email.from],
        ["Subject", email.subject || "(no subject)"],
        ["Received", email.createdAt],
      ]);
      return {
        eventId: `resend:${email.id}`,
        text: body ? `${header}\n\n${clip(body)}` : header,
        label: `Email · ${email.subject || "New mail"}`.slice(0, 120),
        fields: { sender },
      };
    },
  };
}

export const EMAIL_ADAPTER = emailAdapter();
