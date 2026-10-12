import { describe, it, expect, vi, beforeEach } from "vitest";
import { avatarSrc } from "./avatar-src";

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://api.covan.test");
});

describe("avatarSrc", () => {
  it("serves an uploaded photo from the API", () => {
    expect(avatarSrc("/avatars/u1/abc.webp")).toBe("https://api.covan.test/avatars/u1/abc.webp");
  });

  it("passes an https address through as it is", () => {
    expect(avatarSrc("https://lh3.example.com/a.png")).toBe("https://lh3.example.com/a.png");
  });

  // The column is the user's own to write. Anything the app would not have put
  // there renders as a monogram instead of being loaded into every member list.
  it.each([
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
