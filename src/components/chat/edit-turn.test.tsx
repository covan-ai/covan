import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditTurn } from "./edit-turn";

const base = {
  value: "How many vacation days do I have?",
  onChange: () => {},
  onCancel: () => {},
  onSave: () => {},
};

const box = (container: HTMLElement) => container.querySelector("[data-part='bubble']");

describe("EditTurn", () => {
  it("opens with the question already in it", () => {
    render(<EditTurn {...base} />);
    expect(screen.getByLabelText("Edit your message")).toHaveValue(base.value);
  });

  it("looks like the bubble it replaces, not like a dialog", () => {
    // The open editor stands exactly where the closed question stood. A
    // different fill would read as the message having been replaced by
    // something else rather than opened.
    const { container } = render(<EditTurn {...base} />);
    expect(box(container)).toHaveClass("bg-bubble", "rounded-2xl");
  });

  it("sends on Enter, because that is what the composer under it does", async () => {
    const onSave = vi.fn();
    render(<EditTurn {...base} onSave={onSave} />);

    await userEvent.type(screen.getByLabelText("Edit your message"), "{Enter}");
    expect(onSave).toHaveBeenCalled();
  });

  it("leaves a newline alone when Shift is held", async () => {
    const onSave = vi.fn();
    render(<EditTurn {...base} onSave={onSave} />);

    await userEvent.type(screen.getByLabelText("Edit your message"), "{Shift>}{Enter}{/Shift}");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("backs out on Escape", async () => {
    const onCancel = vi.fn();
    render(<EditTurn {...base} onCancel={onCancel} />);

    await userEvent.type(screen.getByLabelText("Edit your message"), "{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("will not send an empty question", async () => {
    render(<EditTurn {...base} value="   " />);
    expect(screen.getByRole("button", { name: "Save & send" })).toBeDisabled();
  });
});
