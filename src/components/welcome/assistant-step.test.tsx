import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantStep } from "./assistant-step";

const empty = { assistantName: null, assistantEmoji: null, assistantRole: null };

function renderStep(over: Partial<Parameters<typeof AssistantStep>[0]> = {}) {
  const onSubmit = vi.fn();
  const onValidityChange = vi.fn();
  render(
    <AssistantStep
      formId="f"
      firstName="Ada"
      value={empty}
      onSubmit={onSubmit}
      onValidityChange={onValidityChange}
      {...over}
    />,
  );
  return { onSubmit, onValidityChange };
}

describe("AssistantStep", () => {
  it("starts with the person's own assistant chosen and named", () => {
    const { onValidityChange } = renderStep();

    const cards = screen.getAllByRole("radio", { name: /assistant|desk|scout|quill/i });
    expect(cards[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Name")).toHaveValue("Ada's assistant");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("fills the name and the face from a ready-made assistant", async () => {
    const { onSubmit } = renderStep();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /scout/i }));
    expect(screen.getByLabelText("Name")).toHaveValue("Scout");
    expect(screen.getByRole("radio", { name: "Use 📊" })).toHaveAttribute("aria-checked", "true");

    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith({
      assistantName: "Scout",
      assistantEmoji: "📊",
      assistantRole: "scout",
    });
  });

  it("records a typed name as the person's own, and refuses an empty one", async () => {
    const { onSubmit, onValidityChange } = renderStep();
    const user = userEvent.setup();
    const name = screen.getByLabelText("Name");

    await user.clear(name);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    fireEvent.submit(name.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(name, "Atlas");
    fireEvent.submit(name.closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ assistantName: "Atlas", assistantRole: "custom" }),
    );
  });

  it("resumes on what was recorded before", () => {
    renderStep({ value: { assistantName: "Quill", assistantEmoji: "✍️", assistantRole: "quill" } });
    expect(screen.getByRole("radio", { name: /quill/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Name")).toHaveValue("Quill");
  });
});
