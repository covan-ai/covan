import { describe, expect, it } from "vitest";
import { httpsUrl } from "./https-url";

describe("httpsUrl", () => {
  it("passes an https address through untouched", () => {
    const live = "https://live.browser-use.com/?wss=abc&token=x%2Fy";
    expect(httpsUrl(live)).toBe(live);
  });

  it.each([
    "javascript:alert(document.domain)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/consent",
    "//example.com/consent",
    "/relative",
    "not a url",
    "",
  ])("refuses %s", (raw) => {
    expect(httpsUrl(raw)).toBeNull();
  });

  it("refuses what is not a string", () => {
    expect(httpsUrl(null)).toBeNull();
    expect(httpsUrl({ href: "https://x" })).toBeNull();
  });
});
