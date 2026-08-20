import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges class names and lets the later Tailwind class win", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy entries", () => {
    // `false && "b"` is deliberately constant: it's the falsy input this assertion is testing.
    // eslint-disable-next-line no-constant-binary-expression
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });
});
