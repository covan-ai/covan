import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let pathname = "/app";
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

import { CoachMarkLayer } from "./coach-mark";
import { _resetCoachMarks, openCoachMark, useCoachMark } from "@/lib/coach-marks";

const target = {
  id: "composer" as const,
  title: "Ask here",
  hint: "Type a question.",
  route: "chat" as const,
};

/** jsdom lays nothing out; give the target a box so it can be found. */
const box = { top: 100, left: 50, width: 300, height: 40 };
const originalRect = Element.prototype.getBoundingClientRect;

function Probe() {
  const open = useCoachMark();
  return <output data-testid="open">{open ? "yes" : "no"}</output>;
}

beforeEach(() => {
  _resetCoachMarks();
  pathname = "/app";
  Element.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-coach")
      ? ({ ...box, right: box.left + box.width, bottom: box.top + box.height } as DOMRect)
      : originalRect.call(this);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  vi.useRealTimers();
});

describe("CoachMarkLayer", () => {
  it("points at the thing, and closes on Esc with focus back where it came from", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button data-coach="composer">the composer</button>
        <button>try</button>
        <CoachMarkLayer />
        <Probe />
      </>,
    );
    const opener = screen.getByRole("button", { name: "try" });

    act(() => openCoachMark(target, { returnFocusTo: opener }));

    const dialog = await screen.findByRole("dialog", { name: "Ask here" });
    expect(dialog).toHaveTextContent("Type a question.");
    expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {});
    expect(opener).toHaveFocus();
    expect(screen.getByTestId("open")).toHaveTextContent("no");
  });

  it("closes on Got it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button data-coach="composer">the composer</button>
        <CoachMarkLayer />
      </>,
    );
    act(() => openCoachMark(target));

    await user.click(await screen.findByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives up on a target that never shows, rather than dimming the page over nothing", async () => {
    vi.useFakeTimers();
    render(
      <>
        <CoachMarkLayer />
        <Probe />
      </>,
    );
    act(() => openCoachMark(target));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("open")).toHaveTextContent("yes");

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByTestId("open")).toHaveTextContent("no");
  });

  it("closes when the page it found the target on is left", async () => {
    const view = render(
      <>
        <button data-coach="composer">the composer</button>
        <CoachMarkLayer />
      </>,
    );
    act(() => openCoachMark(target));
    await screen.findByRole("dialog");

    pathname = "/settings";
    view.rerender(
      <>
        <button data-coach="composer">the composer</button>
        <CoachMarkLayer />
      </>,
    );
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
