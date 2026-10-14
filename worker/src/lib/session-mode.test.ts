import { describe, it, expect } from "vitest";
import { effectiveMode, effectiveTuning } from "./session-mode";

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
  it("takes the session's own mode over the agent's", () => {
    expect(effectiveMode({ kind: "chat", mode: "brainstorm" }, { mode: "normal" })).toBe(
      "brainstorm",
    );
    expect(effectiveMode({ kind: "chat", mode: "normal" }, { mode: "brainstorm" })).toBe("normal");
  });
  it("inherits the agent's mode when the session's is null", () => {
    expect(effectiveMode({ kind: "chat", mode: null }, { mode: "brainstorm" })).toBe("brainstorm");
  });
  it("keeps a brainstorm-kind session a brainstorm even when its mode says normal", () => {
    expect(effectiveMode({ kind: "brainstorm", mode: "normal" }, { mode: "normal" })).toBe(
      "brainstorm",
    );
  });
});

describe("effectiveTuning", () => {
  const agent = { model: "gpt-4.1", reasoning_effort: "low", web_search: true };

  it("inherits everything from the agent when the session sets nothing", () => {
    expect(effectiveTuning({}, agent)).toEqual({
      model: "gpt-4.1",
      reasoningEffort: "low",
      webSearch: true,
    });
    expect(
      effectiveTuning({ model: null, reasoning_effort: null, web_search: null }, agent),
    ).toEqual({ model: "gpt-4.1", reasoningEffort: "low", webSearch: true });
  });

  it("takes each of the session's values over the agent's", () => {
    expect(
      effectiveTuning(
        { model: "claude-opus-5", reasoning_effort: "high", web_search: false },
        agent,
      ),
    ).toEqual({ model: "claude-opus-5", reasoningEffort: "high", webSearch: false });
  });

  it("treats thinking off ('minimal') as a value, not as unset", () => {
    expect(effectiveTuning({ reasoning_effort: "minimal" }, agent).reasoningEffort).toBe("minimal");
  });

  it("defaults web search to off when neither says", () => {
    expect(effectiveTuning({}, {}).webSearch).toBe(false);
    expect(effectiveTuning({}, {}).model).toBeNull();
    expect(effectiveTuning({}, {}).reasoningEffort).toBeNull();
  });

  it("passes over a session model this deployment does not serve", () => {
    expect(effectiveTuning({ model: "claude-opus-5" }, agent, ["gpt-4.1"]).model).toBe("gpt-4.1");
    expect(effectiveTuning({ model: "gpt-4o" }, agent, ["gpt-4.1", "gpt-4o"]).model).toBe("gpt-4o");
  });
});
