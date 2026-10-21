import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstDocument } from "./first-document";

function renderIt(over: Partial<Parameters<typeof FirstDocument>[0]> = {}) {
  const onPick = vi.fn();
  const onKnowledge = vi.fn();
  render(
    <FirstDocument
      agentName="Ada"
      canUpload
      isShared={false}
      onPick={onPick}
      onKnowledge={onKnowledge}
      {...over}
    />,
  );
  return { onPick, onKnowledge };
}

describe("FirstDocument", () => {
  it("offers the picker and the Knowledge tab to somebody who can upload", async () => {
    const { onPick, onKnowledge } = renderIt();

    expect(screen.getByText("Upload your first document")).toBeInTheDocument();
    expect(screen.getByText(/Ada answers from what your team uploads/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Upload a document" }));
    expect(onPick).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open the Knowledge tab" }));
    expect(onKnowledge).toHaveBeenCalled();
  });

  it("sends a shared thread to the Knowledge tab, because a chat upload would be private", async () => {
    const { onPick, onKnowledge } = renderIt({ isShared: true });

    expect(screen.queryByRole("button", { name: "Upload a document" })).toBeNull();
    expect(screen.getByText(/which a shared thread can't read/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Add documents on the Knowledge tab" }),
    );
    expect(onKnowledge).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("gives somebody who cannot upload a sentence, not a call to action", () => {
    renderIt({ canUpload: false });

    expect(screen.getByText("Nobody has added documents to Ada yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
