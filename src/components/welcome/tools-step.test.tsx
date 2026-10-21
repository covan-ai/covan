import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { sendFeedback } = vi.hoisted(() => ({ sendFeedback: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: { feedback: { send: sendFeedback } },
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ToolsStep } from "./tools-step";

function renderStep(value: string[] | null = null) {
  const onSubmit = vi.fn();
  const onValidityChange = vi.fn();
  render(
    <ToolsStep formId="f" value={value} onSubmit={onSubmit} onValidityChange={onValidityChange} />,
  );
  return { onSubmit, onValidityChange };
}

beforeEach(() => {
  sendFeedback.mockReset();
  sendFeedback.mockResolvedValue({ id: "fb-1", createdAt: 0 });
});

describe("ToolsStep", () => {
  it("cannot continue until something is picked, and then can", async () => {
    const { onValidityChange } = renderStep();
    const user = userEvent.setup();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    const gmail = screen.getByRole("checkbox", { name: /gmail/i });
    await user.click(gmail);
    expect(gmail).toHaveAttribute("aria-checked", "true");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("records the picks in the order they were made", async () => {
    const { onSubmit } = renderStep();
    const user = userEvent.setup();

    await user.click(screen.getByRole("checkbox", { name: /notion/i }));
    await user.click(screen.getByRole("checkbox", { name: /gmail/i }));
    fireEvent.submit(screen.getByLabelText("Search tools").closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith(["notion", "gmail"]);
  });

  it("submits with the tile under Enter switched on", async () => {
    const { onSubmit } = renderStep();
    const user = userEvent.setup();

    screen.getByRole("checkbox", { name: /gmail/i }).focus();
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledWith(["gmail"]);
  });

  it("searches, and offers to ask for what is not there", async () => {
    renderStep();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Search tools"), "crm");
    expect(screen.getByRole("checkbox", { name: /hubspot/i })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /gmail/i })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search tools"));
    await user.type(screen.getByLabelText("Search tools"), "Fancy CRM");
    expect(screen.getByText(/couldn't find/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /request it/i }));
    expect(sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "idea", message: expect.stringContaining("Fancy CRM") }),
    );
  });

  it("resumes with what was picked before", () => {
    renderStep(["slack"]);
    expect(screen.getByRole("checkbox", { name: /slack/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
