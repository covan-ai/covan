import { describe, it, expect } from "vitest";

import { encryptSecret, decryptSecret, hintFor } from "./crypto";

// 32 bytes of zeroes and 32 bytes of ones, base64. Fixed so the suite is
// deterministic; nothing here is a real key.
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a key", async () => {
    const { ciphertext, iv } = await encryptSecret(SECRET, "sk-proj-abcdef123456");
    expect(await decryptSecret(SECRET, ciphertext, iv)).toBe("sk-proj-abcdef123456");
  });

  it("never produces the plaintext in the ciphertext", async () => {
    const { ciphertext } = await encryptSecret(SECRET, "sk-proj-abcdef123456");
    expect(ciphertext).not.toContain("sk-proj");
  });

  it("uses a fresh IV each time, so the same key encrypts differently", async () => {
    const a = await encryptSecret(SECRET, "sk-same");
    const b = await encryptSecret(SECRET, "sk-same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("returns null under the wrong secret rather than throwing", async () => {
    const { ciphertext, iv } = await encryptSecret(SECRET, "sk-proj-abcdef123456");
    // A rotated PROVIDER_KEY_SECRET must not 500 every chat request for a
    // workspace that is out of allowance. It falls back to the operator's key.
    await expect(decryptSecret(OTHER, ciphertext, iv)).resolves.toBeNull();
  });

  it("returns null on garbage rather than throwing", async () => {
    await expect(decryptSecret(SECRET, "not-base64!!", "nor-this")).resolves.toBeNull();
  });

  it("refuses a secret that is not 32 bytes", async () => {
    await expect(encryptSecret(btoa("short"), "sk-x")).rejects.toThrow(/32 bytes/);
  });
});

describe("hintFor", () => {
  it("shows enough to recognise a key and not enough to use one", () => {
    expect(hintFor("sk-proj-abcdef123456")).toBe("sk-…3456");
  });

  it("does not fall apart on a short string", () => {
    expect(hintFor("abc")).toBe("abc");
  });
});
