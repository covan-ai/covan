import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelCost } from "./model-cost";

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

describe("in credits, on the hosted service", () => {
  it("says the price in credits beside a model", () => {
    render(<ModelCost price={{ unit: "credits", amount: 14.2 }} />);
    expect(screen.getByText("~14 credits")).toBeInTheDocument();
  });

  it("never prints a fraction of a credit as nothing", () => {
    render(<ModelCost price={{ unit: "credits", amount: 0.6 }} />);
    expect(screen.getByText("<1 credit")).toBeInTheDocument();
  });
});
