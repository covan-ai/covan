import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceCards } from "./choice-cards";

const options = [
  { id: "a", label: "Alpha", line: "First." },
  { id: "b", label: "Beta", line: "Second." },
  { id: "c", label: "Gamma", line: "Third." },
];

describe("ChoiceCards", () => {
  it("is a radio group, with one answer", async () => {
    const onChange = vi.fn();
    render(<ChoiceCards name="Pick" options={options} value="b" onChange={onChange} />);
    const user = userEvent.setup();

    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /beta/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /alpha/i })).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("radio", { name: /gamma/i }));
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("picks and advances on Enter, and moves with the arrows", async () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    render(
      <ChoiceCards
        name="Pick"
        options={options}
        value={null}
        onChange={onChange}
        onEnter={onEnter}
      />,
    );
    const user = userEvent.setup();

    screen.getByRole("radio", { name: /alpha/i }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(screen.getByRole("radio", { name: /beta/i })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onEnter).toHaveBeenCalledWith("b");
  });
});
