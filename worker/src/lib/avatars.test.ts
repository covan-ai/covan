import { describe, expect, it } from "vitest";
import {
  avatarKey,
  avatarKeyFromUrl,
  avatarPath,
  contentTypeForAvatarFile,
  sniffImage,
} from "./avatars";

const USER = "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b";
const FILE = "0123456789abcdef0123456789abcdef.png";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (s: string) => new TextEncoder().encode(s);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56);

describe("sniffImage", () => {
  it("knows the three formats by their signatures", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
  });

  // An SVG is a document that can carry script. It is refused, not cleaned.
  it("refuses an SVG, whatever it claims to be", () => {
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(sniffImage(text('<?xml version="1.0"?><svg/>'))).toBeNull();
  });

  it("refuses a GIF, an empty file and a truncated signature", () => {
    expect(sniffImage(text("GIF89a......"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e))).toBeNull();
    // RIFF without WEBP is a WAV or an AVI.
    expect(sniffImage(text("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
  });
});

describe("avatarKey", () => {
  it("is a fresh random file under the user's prefix, named for the sniffed type", () => {
    const a = avatarKey(USER, "image/png");
    const b = avatarKey(USER, "image/png");

    expect(a).toMatch(new RegExp(`^avatars/${USER}/[0-9a-f]{32}\\.png$`));
    expect(a).not.toBe(b);
    expect(avatarKey(USER, "image/jpeg")).toMatch(/\.jpg$/);
    expect(avatarKey(USER, "image/webp")).toMatch(/\.webp$/);
  });

  it("round-trips through the path stored on the profile", () => {
    const key = avatarKey(USER, "image/webp");
    expect(avatarKeyFromUrl(avatarPath(key), USER)).toBe(key);
  });
});

describe("avatarKeyFromUrl", () => {
  // A co-member's photo path is visible in /me and the column is the user's
  // own to write, so a path under another id must never become a delete.
  it("refuses a path under somebody else's id", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(avatarKeyFromUrl(`/avatars/${other}/${FILE}`, USER)).toBeNull();
  });

  it("finds the key behind a path of ours", () => {
    expect(avatarKeyFromUrl(`/avatars/${USER}/${FILE}`, USER)).toBe(`avatars/${USER}/${FILE}`);
  });

  // Each of these decides a store delete, so anything looser than the exact
  // shape `avatarPath` writes is somebody else's URL.
  it("finds nothing behind anything else", () => {
    expect(avatarKeyFromUrl(null, USER)).toBeNull();
    expect(avatarKeyFromUrl("", USER)).toBeNull();
    expect(avatarKeyFromUrl(`https://cdn.example.com/avatars/${USER}/${FILE}`, USER)).toBeNull();
    expect(avatarKeyFromUrl(`/avatars/../${FILE}`, USER)).toBeNull();
    expect(avatarKeyFromUrl(`/avatars/${USER}/../../secret.png`, USER)).toBeNull();
    expect(avatarKeyFromUrl(`/avatars/${USER.toUpperCase()}/${FILE}`, USER)).toBeNull();
    expect(avatarKeyFromUrl(`/avatars/${USER}/${FILE.toUpperCase()}`, USER)).toBeNull();
    expect(avatarKeyFromUrl(`/avatars/${USER}/0123456789abcdef0123456789abcdef`, USER)).toBeNull();
    expect(
      avatarKeyFromUrl(`/avatars/${USER}/0123456789abcdef0123456789abcdef.svg`, USER),
    ).toBeNull();
    expect(avatarKeyFromUrl(`avatars/${USER}/${FILE}`, USER)).toBeNull();
  });
});

describe("contentTypeForAvatarFile", () => {
  it("derives the type from the validated extension", () => {
    expect(contentTypeForAvatarFile(FILE)).toBe("image/png");
    expect(contentTypeForAvatarFile(FILE.replace(".png", ".jpg"))).toBe("image/jpeg");
    expect(contentTypeForAvatarFile(FILE.replace(".png", ".webp"))).toBe("image/webp");
  });

  it("has no answer for a name it would not have generated", () => {
    expect(contentTypeForAvatarFile("x.svg")).toBeNull();
    expect(contentTypeForAvatarFile("0123456789abcdef0123456789abcde.png")).toBeNull();
  });
});
