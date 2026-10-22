import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ComposerAddMenu } from "./composer-add-menu";

describe("ComposerAddMenu", () => {
  it("offers only what it was given, and runs the one picked", () => {
    const onReport = vi.fn();
    render(<ComposerAddMenu onAttach={vi.fn()} onReport={onReport} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Add to this message" }), {
      key: "Enter",
    });
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Attach a file", "Write a report"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Write a report" }));
    expect(onReport).toHaveBeenCalled();
  });

  it("is not drawn for somebody who can add nothing", () => {
    const { container } = render(<ComposerAddMenu />);
    expect(container).toBeEmptyDOMElement();
  });
});
