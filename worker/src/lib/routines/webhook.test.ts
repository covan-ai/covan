import { describe, it, expect } from "vitest";
import {
  generateSigningSecret,
  serialiseWebhookSecret,
  parseWebhookSecret,
  buildWebhookPayload,
  signWebhookBody,
  webhookHeaders,
  SIGNING_SECRET_PREFIX,
} from "./webhook";
import { looksLikeApiKey } from "../api-keys";

describe("the signing secret", () => {
  it("is one selectable word with a scannable prefix", () => {
    const secret = generateSigningSecret();
    expect(secret.startsWith(SIGNING_SECRET_PREFIX)).toBe(true);
    // base64url: nothing a shell, a URL or a YAML file will argue about.
    expect(secret.slice(SIGNING_SECRET_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, generateSigningSecret));
    expect(seen.size).toBe(50);
  });

  // `authMiddleware` decides a bearer token is an API key by its prefix. A
  // signing secret is not a credential for calling this API — it travels the
  // other way — and a collision here would send one down the key lookup path.
  it("is not mistaken for an API key", () => {
    expect(looksLikeApiKey(generateSigningSecret())).toBe(false);
  });
});

describe("the stored secret", () => {
  it("round-trips the url and the signing secret", () => {
    const config = { url: "https://receiver.example.com/covan", signingSecret: "whsec_abc" };
    expect(parseWebhookSecret(serialiseWebhookSecret(config))).toEqual(config);
  });

  it("carries a version a later reader can refuse", () => {
    const stored = JSON.parse(
      serialiseWebhookSecret({ url: "https://e.com", signingSecret: "whsec_a" }),
    );
    expect(stored.v).toBe(1);
  });

  // A lenient parse would POST an unsigned body at a receiver that is about to
  // reject it, five times, and then pause a working routine over it.
  it.each([
    ["not json at all", "https://receiver.example.com/covan"],
    ["an unknown version", JSON.stringify({ v: 2, url: "https://e.com", signingSecret: "s" })],
    ["no url", JSON.stringify({ v: 1, signingSecret: "s" })],
    ["no signing secret", JSON.stringify({ v: 1, url: "https://e.com" })],
    ["an empty url", JSON.stringify({ v: 1, url: "", signingSecret: "s" })],
    ["a url that is not a string", JSON.stringify({ v: 1, url: 42, signingSecret: "s" })],
    ["null", "null"],
  ])("refuses %s", (_case, stored) => {
    expect(() => parseWebhookSecret(stored)).toThrow();
  });
});

describe("the payload", () => {
  const base = {
    event: "routine.delivered",
    deliveryId: "d-1",
    sentAt: new Date("2026-09-20T09:00:00.000Z"),
    subject: "Weekly digest",
    body: "3 new posts",
  };

  it("states its own version and an ISO instant", () => {
    const payload = buildWebhookPayload(base);
    expect(payload.version).toBe(1);
    expect(payload.sentAt).toBe("2026-09-20T09:00:00.000Z");
  });

  it("omits a routine it was not given rather than sending null", () => {
    const payload = buildWebhookPayload(base);
    expect("routine" in payload).toBe(false);
    expect("run" in payload).toBe(false);
  });

  // The wire format is the list in buildWebhookPayload, not whatever the
  // caller happened to pass. A field added to the input for an internal reason
  // must not appear on a contract receivers are already written against.
  it("sends only the fields the contract names", () => {
    const payload = buildWebhookPayload({
      ...base,
      routine: { id: "r-1", name: "Weekly digest", agentId: "a-1" },
      run: { itemsNew: 3, itemsOverflow: 0, triggeredBy: "schedule" },
      secretInternalField: "should not travel",
    } as never);

    expect(Object.keys(payload).sort()).toEqual(
      ["body", "deliveryId", "event", "routine", "run", "sentAt", "subject", "version"].sort(),
    );
  });
});

describe("the signature", () => {
  it("covers the timestamp, so a captured body cannot replay forever", async () => {
    const at = await signWebhookBody("whsec_k", 1_758_351_600, `{"a":1}`);
    const later = await signWebhookBody("whsec_k", 1_758_351_601, `{"a":1}`);
    expect(at).not.toBe(later);
  });

  it("covers the body, so a tampered one does not verify", async () => {
    const one = await signWebhookBody("whsec_k", 1_758_351_600, `{"a":1}`);
    const two = await signWebhookBody("whsec_k", 1_758_351_600, `{"a":2}`);
    expect(one).not.toBe(two);
  });

  it("announces its scheme in the header value", async () => {
    expect(await signWebhookBody("whsec_k", 1, "{}")).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});

describe("the headers", () => {
  it("names the event, the delivery and the signature", () => {
    const headers = webhookHeaders({
      event: "routine.delivered",
      deliveryId: "d-1",
      timestampSeconds: 1_758_351_600,
      signature: "v1=abc",
    });
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Covan-Event": "routine.delivered",
      "X-Covan-Delivery": "d-1",
      "X-Covan-Timestamp": "1758351600",
      "X-Covan-Signature": "v1=abc",
    });
  });
});
