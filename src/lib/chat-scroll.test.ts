import { describe, it, expect } from "vitest";
import { isPinnedToBottom, STICK_TOLERANCE_PX } from "./chat-scroll";

const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 800 });

describe("isPinnedToBottom", () => {
  it("is true at the bottom", () => {
    expect(isPinnedToBottom(box(1200))).toBe(true);
  });

  it("is true within the tolerance, so a few pixels of rounding do not unstick it", () => {
    expect(isPinnedToBottom(box(1200 - STICK_TOLERANCE_PX))).toBe(true);
  });

  it("is false once the reader has scrolled up to read something", () => {
    // The whole point: a streaming reply must not drag the view back down
    // while someone is reading an earlier answer.
    expect(isPinnedToBottom(box(400))).toBe(false);
  });

  it("is true when there is nothing to scroll", () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 500, clientHeight: 800 })).toBe(true);
  });

  it("is true past the bottom, where a rubber-banding trackpad leaves it", () => {
    expect(isPinnedToBottom(box(1400))).toBe(true);
  });
});
