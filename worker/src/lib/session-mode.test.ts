import { describe, it, expect } from "vitest";
import { effectiveMode } from "./session-mode";

describe("effectiveMode", () => {
  it("is brainstorm when the session is a brainstorm, regardless of agent mode", () => {
    expect(effectiveMode({ kind: "brainstorm" }, { mode: "normal" })).toBe("brainstorm");
  });
  it("is brainstorm when the agent is in brainstorm mode, regardless of session kind", () => {
    expect(effectiveMode({ kind: "chat" }, { mode: "brainstorm" })).toBe("brainstorm");
  });
  it("is normal for a plain chat with a normal agent", () => {
    expect(effectiveMode({ kind: "chat" }, { mode: "normal" })).toBe("normal");
    expect(effectiveMode({}, {})).toBe("normal");
  });
});
