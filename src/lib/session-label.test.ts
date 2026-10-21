import { describe, it, expect } from "vitest";
import { sessionLabel } from "./session-label";

describe("sessionLabel", () => {
  it("is the title once there is one", () => {
    expect(sessionLabel({ title: "Q3 pricing review", kind: "chat" })).toBe("Q3 pricing review");
    expect(sessionLabel({ title: "  Padded  ", kind: "brainstorm" })).toBe("Padded");
  });

  it("names an untitled conversation for what it is", () => {
    expect(sessionLabel({ title: null, kind: "chat" })).toBe("New thread");
    expect(sessionLabel({ title: null, kind: "brainstorm" })).toBe("New brainstorm");
  });

  it("treats a title of spaces as no title", () => {
    // The sidebar used to draw a blank row for this one.
    expect(sessionLabel({ title: "   ", kind: "chat" })).toBe("New thread");
  });

  it("reads as a thread when the caller cannot say which kind it is", () => {
    expect(sessionLabel({ title: null })).toBe("New thread");
  });
});
