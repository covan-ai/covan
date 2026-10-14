import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./secret-box";

// A fixed 32-byte key, base64. Test-only.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", async () => {
    const secret = "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE";
    expect(await decryptSecret(await encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time (fresh IV)", async () => {
    const a = await encryptSecret("same", KEY);
    const b = await encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe(await decryptSecret(b, KEY));
  });

  it("emits v1.iv.ciphertext, iv and ciphertext base64", async () => {
    const payload = await encryptSecret("x", KEY);
    const [version, iv, ct] = payload.split(".");
    expect(payload.split(".")).toHaveLength(3);
    expect(version).toBe("v1");
    expect(atob(iv)).toHaveLength(12);
    expect(ct.length).toBeGreaterThan(0);
  });

  it("rejects a tampered ciphertext rather than returning garbage", async () => {
    const payload = await encryptSecret("secret", KEY);
    const [version, iv, ct] = payload.split(".");
    const flipped = ct[0] === "A" ? "B" + ct.slice(1) : "A" + ct.slice(1);
    await expect(decryptSecret(`${version}.${iv}.${flipped}`, KEY)).rejects.toThrow();
  });

  // A rotation that changed the envelope without changing the version would be
  // undebuggable; this is the error that makes it obvious instead.
  it("rejects an unknown or missing envelope version", async () => {
    const payload = await encryptSecret("secret", KEY);
    const [, iv, ct] = payload.split(".");
    await expect(decryptSecret(`v2.${iv}.${ct}`, KEY)).rejects.toThrow(
      /unsupported secret payload version: v2/,
    );
    // The pre-version shape, which is what a row written by an older build
    // would look like.
    await expect(decryptSecret(`${iv}.${ct}`, KEY)).rejects.toThrow(
      /unsupported secret payload version/,
    );
    await expect(decryptSecret("", KEY)).rejects.toThrow(/unsupported secret payload version/);
  });

  it("rejects the wrong key", async () => {
    const other = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    await expect(decryptSecret(await encryptSecret("secret", KEY), other)).rejects.toThrow();
  });
});

describe("a sealed value's purpose", () => {
  const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

  it("opens only for the purpose it was sealed for", async () => {
    const { encryptSecret, decryptSecret } = await import("./secret-box");
    const state = await encryptSecret("x", KEY_B64, "covan/oauth-state/v2");

    expect(await decryptSecret(state, KEY_B64, "covan/oauth-state/v2")).toBe("x");
    // One key seals stored secrets, states and grants. Without a purpose any
    // of them would open as any other.
    await expect(decryptSecret(state, KEY_B64, "covan/oauth-grant/v1")).rejects.toThrow();
    await expect(decryptSecret(state, KEY_B64)).rejects.toThrow();
  });

  it("leaves a stored secret, sealed with no purpose, readable as before", async () => {
    const { encryptSecret, decryptSecret } = await import("./secret-box");
    expect(await decryptSecret(await encryptSecret("y", KEY_B64), KEY_B64)).toBe("y");
  });
});
