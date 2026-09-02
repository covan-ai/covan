import { describe, it, expect } from "vitest";
import { verifySlackSignature } from "./verify";

const SECRET = "slack-signing-secret";
const NOW = Date.parse("2026-09-02T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW / 1000));
const BODY = JSON.stringify({ type: "event_callback" });

/** What Slack would have sent, computed the way Slack computes it. */
async function sign(secret: string, timestamp: string, body: string): Promise<string> {
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
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  return `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("slack signature", () => {
  it("accepts a delivery Slack actually signed", async () => {
    const signature = await sign(SECRET, TIMESTAMP, BODY);
    expect(
      await verifySlackSignature(SECRET, { signature, timestamp: TIMESTAMP }, BODY, NOW),
    ).toEqual({ ok: true });
  });

  it("refuses an unsigned request", async () => {
    expect(
      await verifySlackSignature(SECRET, { signature: undefined, timestamp: TIMESTAMP }, BODY, NOW),
    ).toMatchObject({ ok: false, reason: "unsigned" });
  });

  it("refuses a signature computed over a different body", async () => {
    const signature = await sign(SECRET, TIMESTAMP, BODY);
    const tampered = JSON.stringify({ type: "event_callback", team_id: "T-other" });
    expect(
      await verifySlackSignature(SECRET, { signature, timestamp: TIMESTAMP }, tampered, NOW),
    ).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("refuses a signature from somebody else's Slack app", async () => {
    const signature = await sign("another-app-secret", TIMESTAMP, BODY);
    expect(
      await verifySlackSignature(SECRET, { signature, timestamp: TIMESTAMP }, BODY, NOW),
    ).toMatchObject({ ok: false });
  });

  // Without this, one captured request replays forever — and a replayed
  // question re-answers, re-posts and re-charges.
  it("refuses a request that is too old to be live traffic", async () => {
    const signature = await sign(SECRET, TIMESTAMP, BODY);
    const sixMinutesLater = NOW + 6 * 60_000;
    expect(
      await verifySlackSignature(
        SECRET,
        { signature, timestamp: TIMESTAMP },
        BODY,
        sixMinutesLater,
      ),
    ).toMatchObject({ ok: false, reason: "stale" });
  });

  it("refuses a timestamp that is not a number", async () => {
    const signature = await sign(SECRET, "not-a-time", BODY);
    expect(
      await verifySlackSignature(SECRET, { signature, timestamp: "not-a-time" }, BODY, NOW),
    ).toMatchObject({ ok: false, reason: "bad timestamp" });
  });

  // A deployment with no signing secret must not accept everything.
  // And it has to refuse before it tries to use the key: WebCrypto throws on a
  // zero-length HMAC key, so a check placed after `importKey` would turn a
  // missing secret into a 500 on every Slack delivery instead of a reason.
  it("fails closed when the deployment has no signing secret", async () => {
    const signature = await sign(SECRET, TIMESTAMP, BODY);
    expect(
      await verifySlackSignature("", { signature, timestamp: TIMESTAMP }, BODY, NOW),
    ).toMatchObject({ ok: false, reason: "no signing secret configured" });
  });
});
