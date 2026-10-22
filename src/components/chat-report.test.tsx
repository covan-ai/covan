import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportDialog } from "./chat-report";
import type { ReportWriter } from "@/lib/use-report";

function writerWith(over: Partial<ReportWriter> = {}): ReportWriter {
  return {
    pending: false,
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    write: vi.fn(async () => {}),
    ...over,
  };
}

describe("ReportDialog", () => {
  it("offers nothing to a viewer, who cannot write a document to the workspace", () => {
    render(<ReportDialog reports={writerWith({ dialogOpen: true })} canWrite={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends the instruction the person typed", async () => {
    const user = userEvent.setup();
    const reports = writerWith({ dialogOpen: true });
    render(<ReportDialog reports={reports} canWrite />);

    await user.type(screen.getByLabelText(/what should the report cover/i), "Sum up the quarter.");
    await user.click(screen.getByRole("button", { name: /^write report$/i }));

    expect(reports.write).toHaveBeenCalledWith("Sum up the quarter.");
  });

  it("will not ask for a report with no instruction", () => {
    const reports = writerWith({ dialogOpen: true });
    render(<ReportDialog reports={reports} canWrite />);

    expect(screen.getByRole("button", { name: /^write report$/i })).toBeDisabled();
    expect(reports.write).not.toHaveBeenCalled();
  });

  it("says it is starting, and cannot be pressed twice while it does", () => {
    render(<ReportDialog reports={writerWith({ dialogOpen: true, pending: true })} canWrite />);

    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
  });

  it("tells the person they need not wait with the tab open", () => {
    render(<ReportDialog reports={writerWith({ dialogOpen: true })} canWrite />);

    expect(screen.getByText(/close the tab while it is written/i)).toBeInTheDocument();
  });

  it("opens when something else opened it — a bare /report typed in the composer", () => {
    // The dialog's open state lives on the writer rather than in here precisely
    // so the command can reach it: `/report` with nothing after it means "I want
    // a report and have not said what about", which is this dialog's question.
    render(<ReportDialog reports={writerWith({ dialogOpen: true })} canWrite />);

    expect(screen.getByLabelText(/what should the report cover/i)).toBeInTheDocument();
  });
});
