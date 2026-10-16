import { describe, expect, it, vi } from "vitest";
import type { ReceivedEmail } from "../../inbound-email/resend";
import { AGENT_TOKEN } from "../../inbound-email/address";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { EMAIL_RECEIVED, approvedSenders, emailAdapter, isApproved } from "./email";

const ENV = {
  INBOUND_EMAIL_DOMAIN: "reply.example.com",
  RESEND_INBOUND_WEBHOOK_SECRET: "whsec_x",
  RESEND_FROM: "Routines <routines@example.com>",
} as never;

function ctx(config: Record<string, unknown> = {}, over: Partial<SubscriptionRow> = {}) {
  return {
    env: ENV,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "email",
      event_type: "email.received",
      config,
      external_id: "abcdefghijklmnop",
      secret_ciphertext: null,
      state: {},
      status: "active",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: EMAIL_RECEIVED,
    secret: null,
  } satisfies AdapterContext;
}

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "e1",
  messageId: "<m1@acme.com>",
  from: "Ayşe <ayse@acme.com>",
  to: ["weekly-abcdefghijklmnop@reply.example.com"],
  subject: "Supplier notes",
  text: "Second batch on the 28th.",
  headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  createdAt: "2026-10-16T11:00:00Z",
  ...over,
});

describe("email.received", () => {
  it("is in the catalogue, served by email, needing nothing connected", () => {
    expect(CATALOGUE.eventType("email.received")).toBe(EMAIL_RECEIVED);
    expect(EMAIL_RECEIVED.requires).toEqual({ kind: "none" });
  });

  it("reads an approved senders list of addresses and domains", () => {
    expect(approvedSenders({ senders: "Ayse@Acme.com, acme.org; @x.io junk" })).toEqual([
      "ayse@acme.com",
      "@acme.org",
      "@x.io",
    ]);
    expect(isApproved("bob@acme.org", ["@acme.org"])).toBe(true);
    expect(isApproved("bob@notacme.org", ["@acme.org"])).toBe(false);
    expect(isApproved("ayse@acme.com", ["ayse@acme.com"])).toBe(true);
  });
});

describe("emailAdapter", () => {
  it("is offered only with inbound mail configured", () => {
    expect(emailAdapter().isConfigured(ENV)).toBe(true);
    expect(emailAdapter().isConfigured({} as never)).toBe(false);
  });

  it("keeps the address a routine already has, and makes one the first time", async () => {
    const adapter = emailAdapter();
    expect(await adapter.subscribe(ctx())).toEqual({ externalId: "abcdefghijklmnop" });
    const fresh = await adapter.subscribe(ctx({}, { external_id: null }));
    expect(fresh.externalId).toMatch(AGENT_TOKEN);
  });

  it("describes mail from a listed sender", async () => {
    const event = await emailAdapter().normalize({ email: email() }, ctx({ senders: "@acme.com" }));
    expect(event).toMatchObject({
      eventId: "resend:e1",
      label: "Email · Supplier notes",
      fields: { sender: "ayse@acme.com" },
    });
    expect(event?.text).toContain("Second batch on the 28th.");
  });

  it("answers to the workspace's members when nobody is listed", async () => {
    const memberAddresses = vi.fn(async () => ["ayse@acme.com"]);
    const adapter = emailAdapter({ memberAddresses });
    expect(await adapter.normalize({ email: email() }, ctx())).not.toBeNull();
    expect(memberAddresses).toHaveBeenCalledWith(ENV, "w1");
    expect(await adapter.normalize({ email: email({ from: "eve@evil.com" }) }, ctx())).toBeNull();
  });

  it("runs nothing for a stranger, an auto-reply, or mail Covan itself sent", async () => {
    const adapter = emailAdapter({ memberAddresses: async () => ["ayse@acme.com"] });
    const listed = ctx({ senders: "ayse@acme.com" });
    expect(await adapter.normalize({ email: email({ from: "bob@acme.com" }) }, listed)).toBeNull();
    expect(
      await adapter.normalize(
        { email: email({ headers: { "auto-submitted": "auto-replied" } }) },
        listed,
      ),
    ).toBeNull();
    expect(
      await adapter.normalize(
        { email: email({ from: "routines@example.com" }) },
        ctx({ senders: "@example.com" }),
      ),
    ).toBeNull();
    expect(
      await adapter.normalize(
        { email: email({ from: "x@reply.example.com" }) },
        ctx({ senders: "@reply.example.com" }),
      ),
    ).toBeNull();
  });
});
