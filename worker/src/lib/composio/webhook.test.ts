import { describe, it, expect } from "vitest";
import { verifyComposioWebhook } from "./webhook";

const SECRET = "composio-webhook-secret";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW / 1000));
const ID = "msg_0b9c1f3e";
const BODY = JSON.stringify({ id: ID, type: "composio.trigger.message", data: {} });

/** What Composio would have sent, computed the way its SDK computes it. */
async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

const headers = (
  signature: string | undefined,
  over: Partial<{ id: string; timestamp: string }> = {},
) => ({
  id: ID,
  timestamp: TIMESTAMP,
  signature,
  ...over,
});

describe("composio webhook signature", () => {
  it("accepts a delivery Composio actually signed", async () => {
    const signature = await sign(SECRET, ID, TIMESTAMP, BODY);
    expect(await verifyComposioWebhook(SECRET, headers(signature), BODY, NOW)).toEqual({
      ok: true,
    });
  });

  it("keys the MAC by the secret's own bytes, not a base64 reading of it", async () => {
    // A Svix-style `whsec_` secret decoded before use would compute a MAC
    // Composio never sent; its SDKs use the text as it is.
    const secret = "whsec_c2VjcmV0LWJ5dGVz";
    const signature = await sign(secret, ID, TIMESTAMP, BODY);
    expect(await verifyComposioWebhook(secret, headers(signature), BODY, NOW)).toEqual({
      ok: true,
    });
  });

  it("accepts any one of several signatures, as during a secret rotation", async () => {
    const good = await sign(SECRET, ID, TIMESTAMP, BODY);
    const old = await sign("the-previous-secret", ID, TIMESTAMP, BODY);
    expect(await verifyComposioWebhook(SECRET, headers(`${old} ${good}`), BODY, NOW)).toEqual({
      ok: true,
    });
  });

  it("refuses a delivery with no signature or no id", async () => {
    expect(await verifyComposioWebhook(SECRET, headers(undefined), BODY, NOW)).toMatchObject({
      ok: false,
      reason: "unsigned",
    });
    const signature = await sign(SECRET, ID, TIMESTAMP, BODY);
    expect(
      await verifyComposioWebhook(SECRET, { ...headers(signature), id: undefined }, BODY, NOW),
    ).toMatchObject({ ok: false, reason: "unsigned" });
  });

  it("refuses a signature over a different body", async () => {
    const signature = await sign(SECRET, ID, TIMESTAMP, BODY);
    const tampered = BODY.replace("{}", '{"to":"someone-else"}');
    expect(await verifyComposioWebhook(SECRET, headers(signature), tampered, NOW)).toMatchObject({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("refuses a signature over a different delivery id", async () => {
    // The id is in the signed string, so a captured signature cannot be
    // re-used under a fresh id to get past the delivery claim.
    const signature = await sign(SECRET, ID, TIMESTAMP, BODY);
    expect(
      await verifyComposioWebhook(SECRET, headers(signature, { id: "msg_other" }), BODY, NOW),
    ).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("refuses somebody else's project secret", async () => {
    const signature = await sign("another-project", ID, TIMESTAMP, BODY);
    expect(await verifyComposioWebhook(SECRET, headers(signature), BODY, NOW)).toMatchObject({
      ok: false,
    });
  });

  it("refuses a delivery too old to be live traffic", async () => {
    const signature = await sign(SECRET, ID, TIMESTAMP, BODY);
    expect(
      await verifyComposioWebhook(SECRET, headers(signature), BODY, NOW + 6 * 60_000),
    ).toMatchObject({ ok: false, reason: "stale" });
  });

  it("refuses a signature of an unknown version", async () => {
    const signature = (await sign(SECRET, ID, TIMESTAMP, BODY)).replace("v1,", "v2,");
    expect(await verifyComposioWebhook(SECRET, headers(signature), BODY, NOW)).toMatchObject({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("refuses everything when no secret is configured, without throwing", async () => {
    const signature = await sign("", ID, TIMESTAMP, BODY).catch(() => "v1,x");
    expect(await verifyComposioWebhook("", headers(signature), BODY, NOW)).toMatchObject({
      ok: false,
      reason: "no webhook secret configured",
    });
  });
});
