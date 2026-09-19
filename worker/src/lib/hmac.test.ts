import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { hmacSha256Hex, timingSafeEqual } from "./hmac";

describe("hmacSha256Hex", () => {
  // RFC 4231, test case 2. A known answer rather than a round trip: a round
  // trip against this module's own output would pass just as happily if the
  // whole thing computed SHA-1, or hashed the key and the message the wrong way
  // round. Receivers verify with their own library, so the bytes have to be
  // right by the standard's definition, not by ours.
  it("matches the published vector", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("is lowercase hex of the full digest", async () => {
    expect(await hmacSha256Hex("k", "m")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the key", async () => {
    expect(await hmacSha256Hex("k1", "same message")).not.toBe(
      await hmacSha256Hex("k2", "same message"),
    );
  });

  // A receiver verifies with its own library over the UTF-8 bytes it received,
  // so agreement on non-ASCII is the interoperability claim, not a detail.
  // Checked against an independent implementation for exactly that reason.
  it("agrees with node:crypto on a non-ASCII body", async () => {
    const message = JSON.stringify({ subject: "Günaydın — haftalık özet" });
    const reference = createHmac("sha256", "anahtar").update(message, "utf8").digest("hex");
    expect(await hmacSha256Hex("anahtar", message)).toBe(reference);
  });
});

describe("timingSafeEqual", () => {
  it("accepts an exact match", () => {
    expect(timingSafeEqual("v1=abc123", "v1=abc123")).toBe(true);
  });

  it("rejects a difference in the last byte", () => {
    expect(timingSafeEqual("v1=abc123", "v1=abc124")).toBe(false);
  });

  // The early return on unequal length is the one place this leaks anything,
  // and all it leaks is the length — which is fixed for every signature this
  // repo compares, so there is nothing there to learn.
  it("rejects a different length without reading past the end", () => {
    expect(timingSafeEqual("v1=abc", "v1=abc123")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("does not treat the empty string as a wildcard", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("v1=abc123", "")).toBe(false);
  });
});
