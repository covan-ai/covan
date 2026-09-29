import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppLogo } from "./app-logo";

/** A mark we hold ourselves, standing in for Notion's or Drive's. */
function TestMark({ className }: { className?: string }) {
  return <svg data-testid="own-mark" className={className} aria-hidden="true" />;
}

const tile = (container: HTMLElement) => container.firstElementChild as HTMLElement;

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

  /**
   * Three sizes, because the tile turns up at three jobs: the 44px row on
   * Integrations, the 36px row inside a connected app's card, and the 28px
   * chip the chat's empty screen lists connected apps with. `DESIGN.md` fixes
   * the proportions — the mark at half the tile, the monogram `text-[10px]` up
   * to 28 and `text-xs` from 36 — so the component owns them rather than each
   * caller guessing.
   */
  it("uses the 44px tile when nobody asks for a size", () => {
    const { container } = render(<AppLogo src="https://api.test/x" name="Gmail" />);
    expect(tile(container)).toHaveClass("h-11", "w-11", "rounded-lg");
    expect(screen.getByRole("presentation", { hidden: true })).toHaveClass("h-[22px]");
  });

  it("scales the mark with the tile rather than leaving it at 22px", () => {
    // The bug this fixes: shrinking the tile with a className left a 22px mark
    // inside a 36px box, which is proportionally LARGER than the 44px tile the
    // ceiling was written for.
    const { container } = render(<AppLogo src="https://api.test/x" name="Gmail" size={36} />);
    expect(tile(container)).toHaveClass("h-9", "w-9");
    expect(screen.getByRole("presentation", { hidden: true })).toHaveClass("h-[18px]");
  });

  it("scales the mark down to the 28px chip", () => {
    const { container } = render(<AppLogo src="https://api.test/x" name="Gmail" size={28} />);
    expect(tile(container)).toHaveClass("h-7", "w-7");
    expect(screen.getByRole("presentation", { hidden: true })).toHaveClass("h-[14px]");
  });

  it("keeps one radius at every size, so a chip is never rounder than a row", () => {
    // Failure mode #4 in `DESIGN.md`: a child rounder than its parent. 8px in a
    // 28px tile would be that, inside a 10px row.
    for (const size of [28, 36, 44] as const) {
      const { container } = render(<AppLogo src="" name="Gmail" size={size} />);
      expect(tile(container)).toHaveClass("rounded-lg");
    }
  });

  it("steps the monogram down with the tile", () => {
    render(<AppLogo src="" name="Obscure Thing" size={28} />);
    expect(screen.getByText("OT")).toHaveClass("text-[10px]");

    render(<AppLogo src="" name="Obscure Thing" size={36} />);
    expect(screen.getAllByText("OT")[1]).toHaveClass("text-xs");
  });

  it("draws a mark we hold ourselves without asking the network for one", () => {
    // Notion and Drive are inline SVGs, not catalogue URLs. Passing the
    // component rather than an element is what lets the tile size it.
    render(<AppLogo mark={TestMark} name="Notion" size={28} />);

    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByTestId("own-mark")).toHaveClass("h-[14px]", "w-[14px]");
  });

  it("prefers the mark we hold over a URL, when it somehow has both", () => {
    render(<AppLogo mark={TestMark} src="https://api.test/x" name="Notion" />);
    expect(screen.getByTestId("own-mark")).toBeInTheDocument();
    expect(screen.queryByRole("presentation", { hidden: true })).not.toBeInTheDocument();
  });
});
