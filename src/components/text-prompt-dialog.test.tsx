import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextPromptDialog } from "./text-prompt-dialog";

function renderPrompt(onSubmit: (v: string) => Promise<boolean>, onOpenChange = vi.fn()) {
  render(
    <TextPromptDialog
      open
      onOpenChange={onOpenChange}
      title="Rename report.pdf"
      label="Name"
      initialValue="report.pdf"
      submitLabel="Rename"
      busyLabel="Renaming…"
      onSubmit={onSubmit}
    />,
  );
  return onOpenChange;
}

describe("TextPromptDialog", () => {
  it("starts from the current value and hands back what was typed, trimmed", async () => {
    const onSubmit = vi.fn(async () => true);
    const onOpenChange = renderPrompt(onSubmit);
    const field = screen.getByLabelText("Name");

    expect(field).toHaveValue("report.pdf");
    await userEvent.clear(field);
    await userEvent.type(field, "  Q3 report  {Enter}");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Q3 report"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // A request that failed was already explained by the caller; the person
  // should be able to fix what they typed, not type it again.
  it("stays open with the text when the caller says it did not work", async () => {
    const onSubmit = vi.fn(async () => false);
    const onOpenChange = renderPrompt(onSubmit);

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText("Name")).toHaveValue("report.pdf");
  });

  it("will not submit nothing", async () => {
    const onSubmit = vi.fn(async () => true);
    renderPrompt(onSubmit);

    await userEvent.clear(screen.getByLabelText("Name"));

    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });
});
