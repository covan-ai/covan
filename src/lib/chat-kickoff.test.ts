import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { markKickoff, takeKickoffFire, useKickoffCardDismissed } from "./chat-kickoff";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("the fire flag", () => {
  it("is spent by the read that takes it", () => {
    markKickoff("s1");
    expect(takeKickoffFire("s1")).toBe(true);
    // A second read — StrictMode, a reload — finds nothing to fire.
    expect(takeKickoffFire("s1")).toBe(false);
  });

  it("is per conversation", () => {
    markKickoff("s1");
    expect(takeKickoffFire("s2")).toBe(false);
    expect(takeKickoffFire("s1")).toBe(true);
  });
});

describe("the card flag", () => {
  it("stays down once put down, for that conversation only", () => {
    const { result } = renderHook(() => useKickoffCardDismissed("s1"));
    expect(result.current.dismissed).toBe(false);

    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    expect(localStorage.getItem("covan:kickoff-card:s1")).toBe("1");

    const other = renderHook(() => useKickoffCardDismissed("s2"));
    expect(other.result.current.dismissed).toBe(false);
  });

  it("answers false with no conversation to ask about", () => {
    const { result } = renderHook(() => useKickoffCardDismissed(undefined));
    expect(result.current.dismissed).toBe(false);
  });
});
