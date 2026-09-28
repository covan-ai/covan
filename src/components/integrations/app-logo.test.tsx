import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppLogo } from "./app-logo";

/**
 * The tile that carries somebody else's mark.
 *
 * One claim, and it is the one that made logos allowable at all: a mark that
 * does not arrive becomes a monogram rather than a broken image. Composio has
 * a documented set of toolkits whose logo URL 404s and at least one that
 * serves the wrong company's mark, so this path is not an edge case — it is
 * the reason the component holds state.
 */
describe("AppLogo", () => {
  it("draws the mark when there is one", () => {
    render(<AppLogo src="https://api.test/composio/logo?u=x" name="Gmail" />);
    const img = screen.getByRole("presentation", { hidden: true });
    expect(img).toHaveAttribute("src", "https://api.test/composio/logo?u=x");
    // The name is beside the tile everywhere this is used; a filled `alt`
    // would have a screen reader say it twice.
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("falls back to a monogram when the mark fails to load", () => {
    render(<AppLogo src="https://api.test/composio/logo?u=gone" name="Hacker News" />);
    fireEvent.error(screen.getByRole("presentation", { hidden: true }));

    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("HN")).toBeInTheDocument();
  });

  it("goes straight to the monogram when the catalogue published no mark", () => {
    render(<AppLogo src="" name="Obscure" />);
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("O")).toBeInTheDocument();
  });
});
