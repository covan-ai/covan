import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { resetRateLimiters } from "../lib/ratelimit";
import { resetMisses } from "../middleware/ratelimit";
import { replyLocalPart } from "../lib/inbound-email/address";
import type { ReceivedEmail } from "../lib/inbound-email/resend";

const receiveEvent = vi.fn();
const receiveReply = vi.fn();
const fetchReceivedEmail = vi.fn();

vi.mock("../lib/routines/events/receive", () => ({ receiveEvent }));
vi.mock("../lib/routines/replies", () => ({ receiveReply }));
vi.mock("../lib/routines/poke-room", () => ({ startPokedRun: vi.fn() }));
vi.mock("../lib/inbound-email/resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/inbound-email/resend")>()),
  fetchReceivedEmail,
}));

const { emailInbound } = await import("./email-inbound");

const KEY_BYTES = new TextEncoder().encode("resend-test-signing-key");
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const ROUTINE_SECRET_KEY = "k".repeat(32);
const ENV = {
  INBOUND_EMAIL_DOMAIN: "reply.example.com",
  RESEND_INBOUND_WEBHOOK_SECRET: SECRET,
  RESEND_API_KEY: "re_test",
  ROUTINE_SECRET_KEY,
  RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20",
};
const RUN = "3f2a91c0-8c01-4d4e-9a1b-0123456789ab";

async function signed(body: string, key = KEY_BYTES) {
  const id = "msg_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`${id}.${ts}.${body}`)),
  );
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
  };
}

const envelope = (to: string[], type = "email.received") =>
  JSON.stringify({ type, data: { email_id: "e1", to, from: "deniz@example.com" } });

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "e1",
  messageId: "<m1@example.com>",
  from: "deniz@example.com",
  to: [],
  subject: "Re: Weekly",
  text: "More please",
  headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  createdAt: "2026-10-16T11:00:00Z",
  ...over,
});

async function post(
  body: string,
  headers: Record<string, string>,
  env: Record<string, string> = ENV,
) {
  const app = new Hono<AppEnv>();
  app.route("/", emailInbound);
  return app.request(
    "/email/inbound",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body },
    env as never,
  );
}

beforeEach(() => {
  receiveEvent.mockReset().mockResolvedValue({ status: "accepted", eventId: "email:resend:e1" });
  receiveReply.mockReset().mockResolvedValue({ status: "accepted", routineId: "r1" });
  fetchReceivedEmail.mockReset().mockResolvedValue(email());
  resetRateLimiters();
  resetMisses();
});

describe("POST /email/inbound", () => {
  it("is not there at all without the domain, the secret and the API key", async () => {
    const body = envelope(["x@reply.example.com"]);
    expect(
      (await post(body, await signed(body), { ...ENV, INBOUND_EMAIL_DOMAIN: "" })).status,
    ).toBe(404);
    expect((await post(body, await signed(body), { ...ENV, RESEND_API_KEY: "" })).status).toBe(404);
  });

  it("refuses a delivery Resend did not sign, before reading it", async () => {
    const body = envelope(["x@reply.example.com"]);
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, await signed(body, new TextEncoder().encode("other")))).status).toBe(
      401,
    );
    expect(fetchReceivedEmail).not.toHaveBeenCalled();
  });

  it("hands an answer to a report to receiveReply, by the run its address names", async () => {
    const local = await replyLocalPart(ROUTINE_SECRET_KEY, RUN);
    const body = envelope([`Covan <${local}@reply.example.com>`]);
    const res = await post(body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, results: ["accepted"] });
    expect(fetchReceivedEmail).toHaveBeenCalledWith("re_test", "e1");
    expect(receiveReply.mock.calls[0][1]).toBe(RUN);
    expect(receiveReply.mock.calls[0][2]).toMatchObject({ id: "e1" });
    expect(receiveEvent).not.toHaveBeenCalled();
  });

  it("hands mail to a routine's own address to receiveEvent, by its token", async () => {
    const body = envelope(["weekly-abcdefghijklmnop@reply.example.com"]);
    await post(body, await signed(body));
    const [, target, raw] = receiveEvent.mock.calls[0];
    expect(target).toEqual({ provider: "email", externalId: "abcdefghijklmnop" });
    expect(raw).toEqual({ email: email() });
  });

  it("runs nothing for a forged reply address, mail its domain did not vouch for, or an auto-reply", async () => {
    const forged = envelope(["r-" + "0".repeat(48) + "@reply.example.com"]);
    expect(await (await post(forged, await signed(forged))).json()).toEqual({
      ok: true,
      results: ["unknown"],
    });

    const local = await replyLocalPart(ROUTINE_SECRET_KEY, RUN);
    const body = envelope([`${local}@reply.example.com`]);
    fetchReceivedEmail.mockResolvedValueOnce(
      email({ authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } }),
    );
    expect(await (await post(body, await signed(body))).json()).toEqual({
      ok: true,
      status: "unauthenticated",
    });
    fetchReceivedEmail.mockResolvedValueOnce(
      email({ headers: { "auto-submitted": "auto-replied" } }),
    );
    expect(await (await post(body, await signed(body))).json()).toEqual({
      ok: true,
      status: "automatic",
    });
    expect(receiveReply).not.toHaveBeenCalled();
  });

  it("acknowledges what is not for us, and asks Resend to retry when the message cannot be read", async () => {
    const elsewhere = envelope(["someone@example.com"]);
    expect(await (await post(elsewhere, await signed(elsewhere))).json()).toEqual({
      ok: true,
      ignored: true,
    });
    const sent = envelope(["x@reply.example.com"], "email.sent");
    expect(await (await post(sent, await signed(sent))).json()).toEqual({
      ok: true,
      ignored: true,
    });

    fetchReceivedEmail.mockRejectedValueOnce(new Error("down"));
    const body = envelope(["weekly-abcdefghijklmnop@reply.example.com"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(body, await signed(body))).status).toBe(502);
    error.mockRestore();
  });
});
