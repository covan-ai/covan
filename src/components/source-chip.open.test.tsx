import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/document-preview-dialog", () => ({
  DocumentPreviewDialog: ({ documentId, name }: { documentId: string; name: string }) => (
    <div role="dialog">{`preview ${documentId} ${name}`}</div>
  ),
}));

import { SourceChip } from "./source-chip";

// A citation you cannot open is a claim you have to take on trust.
describe("a citation", () => {
  it("opens the document it cites", async () => {
    render(<SourceChip source={{ id: "d1", name: "handbook.md" }} />);

    await userEvent.click(screen.getByRole("button", { name: /open handbook\.md/i }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("preview d1 handbook.md");
  });

  it("stays a label when it has no id to open", () => {
    render(<SourceChip source={{ id: null, name: "old-reply.md" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
