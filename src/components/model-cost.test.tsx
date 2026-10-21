import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelCost, ModelCostScale } from "./model-cost";

describe("ModelCost", () => {
  it("shows money rather than a rating", () => {
    render(<ModelCost price={{ unit: "usd", amount: 0.0148 }} />);
    expect(screen.getByText("$0.015")).toBeInTheDocument();
  });

  // Under a custom endpoint every id is unknown by design. A blank is the
  // honest shape of that; a borrowed number would be a claim about somebody
  // else's hardware.
  it("renders nothing when there is no price", () => {
    const { container } = render(<ModelCost price={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ModelCostScale", () => {
  it("names the price and what it assumed to get there", () => {
    render(<ModelCostScale price={{ unit: "usd", amount: 0.0148 }} />);

    expect(screen.getByText("$0.015 / reply")).toBeInTheDocument();
    // The assumption is not decoration: somebody whose agent reads forty-page
    // documents has to be able to tell at a glance that this is not their
    // number.
    expect(screen.getByText(/2,248-token prompt and a 921-token answer/)).toBeInTheDocument();
  });

  it("explains itself instead of going blank when there is no price", () => {
    render(<ModelCostScale price={null} />);

    expect(screen.getByText(/No price for this model/)).toBeInTheDocument();
    expect(screen.queryByText(/\/ reply/)).not.toBeInTheDocument();
  });

  it("marks exactly one band, and the right one", () => {
    const { container } = render(<ModelCostScale price={{ unit: "usd", amount: 0.0148 }} />);
    const filled = container.querySelectorAll(".bg-foreground");

    expect(filled).toHaveLength(1);
    // $0.0148 is the middle band — under 1½¢.
    const bands = Array.from(container.querySelectorAll("div.flex.gap-1 > span"));
    expect(bands[1]).toHaveTextContent("½¢–1½¢");
    expect(bands[1]?.className).toContain("text-foreground");
  });

  it("marks no band at all when there is nothing to place", () => {
    const { container } = render(<ModelCostScale price={null} />);
    expect(container.querySelectorAll(".bg-foreground")).toHaveLength(0);
  });

  // DESIGN.md: amber is a pointer, capped at about five per viewport and 44px
  // each. The Select above already points at the current model, and a band is
  // wider than 44px — so this scale is drawn in ink on purpose.
  it("spends none of the amber budget", () => {
    const { container } = render(<ModelCostScale price={{ unit: "usd", amount: 0.0148 }} />);
    expect(container.innerHTML).not.toMatch(/amber|accent/);
  });
});

describe("in credits, on the hosted service", () => {
  it("says the price in credits beside a model", () => {
    render(<ModelCost price={{ unit: "credits", amount: 14.2 }} />);
    expect(screen.getByText("~14 credits")).toBeInTheDocument();
  });

  it("never prints a fraction of a credit as nothing", () => {
    render(<ModelCost price={{ unit: "credits", amount: 0.6 }} />);
    expect(screen.getByText("<1 credit")).toBeInTheDocument();
  });

  it("gives the figure and its assumption, without the dollar ruler", () => {
    // The ruler's edges are absolute amounts of money. Labelling them in
    // credits would need the rate on the client, which the open tree does not
    // have and should not guess.
    const { container } = render(<ModelCostScale price={{ unit: "credits", amount: 14.2 }} />);

    expect(screen.getByText("~14 credits / reply")).toBeInTheDocument();
    expect(screen.getByText(/at today.s rate/)).toBeInTheDocument();
    expect(screen.getByText(/2,248-token prompt and a 921-token answer/)).toBeInTheDocument();
    expect(container.querySelectorAll("div.flex.gap-1 > span")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/¢|\$/);
    expect(container.innerHTML).not.toMatch(/amber|accent/);
  });
});
