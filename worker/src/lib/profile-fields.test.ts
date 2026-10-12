import { describe, expect, it } from "vitest";
import { BCP47_RE, canonicalTimeZone } from "./profile-fields";

describe("canonicalTimeZone", () => {
  it("spells a zone the way the runtime does", () => {
    expect(canonicalTimeZone("europe/istanbul")).toBe("Europe/Istanbul");
    expect(canonicalTimeZone("  Europe/Istanbul  ")).toBe("Europe/Istanbul");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
  });

  it("refuses what is not a zone", () => {
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
    expect(canonicalTimeZone("../x")).toBeNull();
    expect(canonicalTimeZone("")).toBeNull();
    expect(canonicalTimeZone("A".repeat(65))).toBeNull();
  });

  // V8 accepts a bare offset as a time zone and resolves it to itself. It is a
  // fixed clock rather than a zone, and the column's check would refuse it, so
  // it has to be refused here first.
  it("refuses a bare offset", () => {
    expect(canonicalTimeZone("+03:00")).toBeNull();
  });
});

describe("BCP47_RE", () => {
  it("accepts the shape of a language tag", () => {
    for (const tag of ["en", "tr-TR", "zh-Hant-TW", "es-419"]) {
      expect(BCP47_RE.test(tag)).toBe(true);
    }
  });

  it("refuses what is not one", () => {
    for (const tag of ["EN", "english", "tr_TR", "", "en-", "e"]) {
      expect(BCP47_RE.test(tag)).toBe(false);
    }
  });
});
