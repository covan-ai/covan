import { describe, it, expect } from "vitest";
import { resolveLegalLink } from "./legal";

describe("resolveLegalLink", () => {
  it("falls back to the built-in page when nothing is configured", () => {
    expect(resolveLegalLink(undefined, "/terms")).toEqual({ href: "/terms", external: false });
  });

  it("treats an empty variable as unset", () => {
    // Vite inlines "" for a variable that is present but blank, and a blank
    // one is a deployment that never got round to it — not a link to nowhere.
    expect(resolveLegalLink("", "/privacy")).toEqual({ href: "/privacy", external: false });
    expect(resolveLegalLink("   ", "/privacy")).toEqual({ href: "/privacy", external: false });
  });

  it("uses the operator's own document when one is configured", () => {
    expect(resolveLegalLink("https://covan.app/terms", "/terms")).toEqual({
      href: "https://covan.app/terms",
      external: true,
    });
  });

  it("trims the surrounding whitespace an env file collects", () => {
    expect(resolveLegalLink("  https://covan.app/privacy  ", "/privacy").href).toBe(
      "https://covan.app/privacy",
    );
  });
});
