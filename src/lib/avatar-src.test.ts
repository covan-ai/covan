import { describe, it, expect, vi, beforeEach } from "vitest";
import { avatarSrc } from "./avatar-src";

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.covan.test");
});

describe("avatarSrc", () => {
  const STORED =
    "/avatars/0b7e7c1e-6a43-4c38-9a59-3f1b2c4d5e6f/0123456789abcdef0123456789abcdef.webp";

  it("serves an uploaded photo from the API", () => {
    expect(avatarSrc(STORED)).toBe(`https://api.covan.test${STORED}`);
  });

  // The column is the user's own to write. Anything the app would not have put
  // there renders as a monogram instead of being loaded into every member list.
  //
  // An https address included: an image on somebody else's server, loaded by
  // every co-member's browser, tells that server who looked and when.
  it.each([
    "https://tracker.example/pixel.png",
    "/avatars/u1/abc.webp",
    "/avatars/../documents/1/download",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "http://example.com/a.png",
    "//evil.example/a.png",
    "/documents/1/download",
    "",
  ])("refuses %s", (url) => {
    expect(avatarSrc(url)).toBeNull();
  });

  it("answers null for no photo at all", () => {
    expect(avatarSrc(null)).toBeNull();
    expect(avatarSrc(undefined)).toBeNull();
  });
});
