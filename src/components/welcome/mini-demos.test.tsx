import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MiniDemo } from "./mini-demos";
import { INTRO } from "@/lib/onboarding-config";

describe("MiniDemo", () => {
  it.each(INTRO.map((s) => s.demo))("draws %s, hidden from a screen reader", (kind) => {
    const { container } = render(<MiniDemo kind={kind} />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  // With motion off a layer that only exists in passing must not sit on top
  // of the final frame. The team demo's two bubbles are both part of the
  // final frame, so only the two demos with a passing layer are asked.
  it("hides every passing layer when motion is switched off", () => {
    for (const kind of ["documents", "schedule"] as const) {
      const { container } = render(<MiniDemo kind={kind} />);
      const passing = container.querySelectorAll(".demo-slot-1, .demo-slot-2");
      expect(passing.length).toBeGreaterThan(0);
      for (const el of passing) expect(el.className).toContain("motion-reduce:hidden");
    }
  });
});
