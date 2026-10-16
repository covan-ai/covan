import { describe, expect, it, vi } from "vitest";
import {
  fetchReceivedEmail,
  isAutomatic,
  newTextOf,
  parseReceivedEmail,
  passesAuthentication,
  verifyResendWebhook,
  type ReceivedEmail,
} from "./resend";

const KEY_BYTES = new TextEncoder().encode("resend-test-signing-key");
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const NOW = Date.parse("2026-10-16T12:00:00Z");

async function svixSignature(id: string, timestamp: string, body: string, key = KEY_BYTES) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      imported,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    ),
  );
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "e1",
  messageId: "<m1@example.com>",
  from: "Ayşe <ayse@example.com>",
  to: ["weekly-abc@reply.example.com"],
  subject: "Re: Weekly digest",
  text: "Thanks — can you dig into the second item?",
  headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  createdAt: "2026-10-16T11:59:00Z",
  ...over,
});

describe("verifyResendWebhook", () => {
  it("accepts Svix's signature made with the decoded whsec_ key", async () => {
    const ts = String(NOW / 1000);
    const body = '{"type":"email.received"}';
    const signature = await svixSignature("msg_1", ts, body);
    expect(
      await verifyResendWebhook(SECRET, { id: "msg_1", timestamp: ts, signature }, body, NOW),
    ).toEqual({
      ok: true,
    });
  });

  it("refuses a MAC made with the secret's text rather than its bytes, a stale one, or none", async () => {
    const ts = String(NOW / 1000);
    const body = "{}";
    const textKeyed = await svixSignature("msg_1", ts, body, new TextEncoder().encode(SECRET));
    expect(
      (
        await verifyResendWebhook(
          SECRET,
          { id: "msg_1", timestamp: ts, signature: textKeyed },
          body,
          NOW,
        )
      ).ok,
    ).toBe(false);
    const old = String(NOW / 1000 - 600);
    const stale = await svixSignature("msg_1", old, body);
    expect(
      await verifyResendWebhook(
        SECRET,
        { id: "msg_1", timestamp: old, signature: stale },
        body,
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      (await verifyResendWebhook("", { id: "a", timestamp: ts, signature: "v1,x" }, body, NOW)).ok,
    ).toBe(false);
  });
});

describe("parseReceivedEmail", () => {
  it("narrows Resend's answer, with headers lowercased whichever shape they came in", () => {
    const parsed = parseReceivedEmail({
      id: "e1",
      message_id: "<m1@example.com>",
      from: "a@example.com",
      to: ["b@reply.example.com"],
      subject: "Hi",
      text: null,
      html: "<p>Hello<br>there</p>",
      headers: { "Auto-Submitted": "no", References: "<a> <b>" },
      authentication: { spf: "pass", dkim: "fail", dmarc: "gray" },
      created_at: "2026-10-16T11:00:00Z",
    });
    expect(parsed).toMatchObject({
      text: "Hello\nthere",
      headers: { "auto-submitted": "no", references: "<a> <b>" },
      authentication: { spf: "pass", dkim: "fail", dmarc: "gray" },
    });
    expect(
      parseReceivedEmail({ id: "e2", headers: [{ name: "List-Id", value: "x" }] })?.headers,
    ).toEqual({
      "list-id": "x",
    });
    expect(parseReceivedEmail({})).toBeNull();
  });
});

describe("fetchReceivedEmail", () => {
  it("reads the message with the API key, and throws on anything but a 2xx", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "e1", from: "a@example.com" }));
    const got = await fetchReceivedEmail("re_key", "e1", fetchImpl as unknown as typeof fetch);
    expect(got.id).toBe("e1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.resend.com/emails/receiving/e1",
      expect.objectContaining({ headers: { Authorization: "Bearer re_key" } }),
    );
    const failing = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      fetchReceivedEmail("k", "e1", failing as unknown as typeof fetch),
    ).rejects.toThrow();
    await expect(
      fetchReceivedEmail("k", "../x", failing as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("passesAuthentication", () => {
  it("wants the sender's domain to have vouched, and DMARC not to have failed", () => {
    expect(passesAuthentication(email())).toBe(true);
    expect(
      passesAuthentication(email({ authentication: { spf: "gray", dkim: "pass", dmarc: "gray" } })),
    ).toBe(true);
    expect(
      passesAuthentication(email({ authentication: { spf: "pass", dkim: "pass", dmarc: "fail" } })),
    ).toBe(false);
    expect(
      passesAuthentication(email({ authentication: { spf: "fail", dkim: "fail", dmarc: "gray" } })),
    ).toBe(false);
    expect(passesAuthentication(email({ authentication: null }))).toBe(false);
  });
});

describe("isAutomatic", () => {
  it("knows an out-of-office, a bounce and a list from a person", () => {
    expect(isAutomatic(email())).toBe(false);
    expect(isAutomatic(email({ headers: { "auto-submitted": "no" } }))).toBe(false);
    expect(isAutomatic(email({ headers: { "auto-submitted": "auto-replied" } }))).toBe(true);
    expect(isAutomatic(email({ headers: { precedence: "bulk" } }))).toBe(true);
    expect(isAutomatic(email({ headers: { "list-id": "<x.example.com>" } }))).toBe(true);
    expect(isAutomatic(email({ subject: "Out of Office: back Monday" }))).toBe(true);
    expect(isAutomatic(email({ from: "MAILER-DAEMON@example.com" }))).toBe(true);
  });
});

describe("newTextOf", () => {
  it("cuts the quoted report under a Gmail, Outlook or plain quote", () => {
    expect(
      newTextOf("Yes please.\n\nOn Thu, 16 Oct 2026 at 09:00, Covan <r@x> wrote:\n> old"),
    ).toBe("Yes please.");
    expect(newTextOf("Yes.\nOn Thu, 16 Oct 2026 at 09:00, Covan\n<r@x> wrote:\n> old")).toBe(
      "Yes.",
    );
    expect(newTextOf("Sure\r\n\r\n-----Original Message-----\r\nFrom: Covan")).toBe("Sure");
    expect(newTextOf("Sure\n\nFrom: Covan <r@x>\nSent: Thursday\nold")).toBe("Sure");
    expect(newTextOf("> quoted\nmine\n-- \nAyşe")).toBe("mine");
  });
});
