import { describe, expect, it } from "vitest";
import { egressCountry } from "./egress";

describe("egressCountry", () => {
  it("lowercases a country Cloudflare names", () => {
    expect(egressCountry("TR")).toBe("tr");
    expect(egressCountry(" de ")).toBe("de");
  });

  it("spells the United Kingdom the provider's way", () => {
    expect(egressCountry("GB")).toBe("uk");
  });

  it.each(["CN", "AX", "IO", "UM"])(
    "pins nothing for %s, where the provider has no proxy and a run has no retry",
    (code) => {
      expect(egressCountry(code)).toBeNull();
    },
  );

  it.each([undefined, null, "", "XX", "T1", "TUR", "1a"])(
    "pins nothing when the request cannot say: %s",
    (header) => {
      expect(egressCountry(header)).toBeNull();
    },
  );
});
