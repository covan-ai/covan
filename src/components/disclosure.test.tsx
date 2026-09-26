import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Disclosure } from "./section-card";

/**
 * The foldable note, and the two properties that make it the house idiom
 * rather than a tooltip: it starts closed, and it is a real `<details>` — so a
 * keyboard and a 375px screen reach it the same way a mouse does, which is
 * `DESIGN.md`'s fifth failure mode avoided rather than argued about.
 */
describe("Disclosure", () => {
  it("shows its label and keeps the detail folded away", () => {
    render(
      <Disclosure label="How it is billed">
        Each person spends their monthly allowance first.
      </Disclosure>,
    );

    expect(screen.getByText("How it is billed")).toBeInTheDocument();
    expect(screen.getByRole("group")).not.toHaveAttribute("open");
  });

  it("is a native details, so it opens with no state of its own", () => {
    const { container } = render(<Disclosure label="Method">A 2,248-token prompt.</Disclosure>);
    const details = container.querySelector("details");

    expect(details).toBeInTheDocument();
    expect(details?.querySelector("summary")).toHaveTextContent("Method");
    // Nothing here listens for a click: the element's own `open` is the state.
    details?.setAttribute("open", "");
    expect(screen.getByText("A 2,248-token prompt.")).toBeVisible();
  });

  it("takes a className for its own margin, not for its skin", () => {
    const { container } = render(
      <Disclosure label="Method" className="mt-3">
        Detail.
      </Disclosure>,
    );
    const details = container.querySelector("details");

    expect(details?.className).toContain("mt-3");
    expect(details?.className).toContain("border-border");
  });
});
