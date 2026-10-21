import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { _resetCoachMarks, closeCoachMark, openCoachMark, useCoachMark } from "./coach-marks";

const target = {
  id: "composer" as const,
  title: "Ask here",
  hint: "Type.",
  route: "chat" as const,
};

beforeEach(() => {
  _resetCoachMarks();
});

describe("the one open coach mark", () => {
  it("is what was opened last, and nothing once closed", () => {
    const { result } = renderHook(() => useCoachMark());
    expect(result.current).toBeNull();

    act(() => openCoachMark(target));
    expect(result.current?.target).toBe(target);
    const first = result.current?.seq;

    // A second "Try" on the same target is a second mark.
    act(() => openCoachMark(target));
    expect(result.current?.seq).not.toBe(first);

    act(() => closeCoachMark());
    expect(result.current).toBeNull();
  });

  it("hands focus back to the button that opened it", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    act(() => openCoachMark(target, { returnFocusTo: button }));

    act(() => closeCoachMark());
    await Promise.resolve();
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
