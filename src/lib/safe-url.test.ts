import { describe, expect, it } from "vitest";
import { safeNavigationUrl } from "./safe-url";

describe("safeNavigationUrl", () => {
  it("passes an https address through as it came", () => {
    const consent = "https://backend.composio.dev/s/AbC?x=1#frag";
    expect(safeNavigationUrl(consent)).toBe(consent);
  });

  it.each([
    "javascript:alert(document.domain)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com",
    "//evil.example/x",
    "/integrations",
    "",
    null,
    undefined,
  ])("refuses %s", (raw) => {
    expect(safeNavigationUrl(raw)).toBeNull();
  });
});
