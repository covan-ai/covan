import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatReport, ChatReportReceipt } from "./chat-report";
import type { ReportReceipt, ReportWriter } from "@/lib/use-report";

const receipt = (over: Partial<ReportReceipt> = {}): ReportReceipt => ({
  documentId: "doc-1",
  name: "Q3 Review.md",
  indexed: false,
  ...over,
});

function writerWith(over: Partial<ReportWriter> = {}): ReportWriter {
  return {
    pending: false,
    receipt: null,
    dialogOpen: false,
    setDialogOpen: vi.fn(),
    write: vi.fn(async () => {}),
    dismiss: vi.fn(),
    download: vi.fn(),
    content: null,
    loadingContent: false,
    ...over,
  };
}

describe("ChatReport", () => {
  it("offers nothing to a viewer, who cannot write a document to the workspace", () => {
    render(<ChatReport reports={writerWith()} canWrite={false} />);

    expect(screen.queryByRole("button", { name: /report/i })).not.toBeInTheDocument();
  });

  it("asks for the dialog when the composer button is pressed", async () => {
    const user = userEvent.setup();
    const reports = writerWith();
    render(<ChatReport reports={reports} canWrite />);

    await user.click(screen.getByRole("button", { name: /write a report/i }));

    expect(reports.setDialogOpen).toHaveBeenCalledWith(true);
  });

  it("sends the instruction the person typed", async () => {
    const user = userEvent.setup();
    const reports = writerWith({ dialogOpen: true });
    render(<ChatReport reports={reports} canWrite />);

    await user.type(screen.getByLabelText(/what should the report cover/i), "Sum up the quarter.");
    await user.click(screen.getByRole("button", { name: /^write report$/i }));

    expect(reports.write).toHaveBeenCalledWith("Sum up the quarter.");
  });

  it("will not ask for a report with no instruction", () => {
    const reports = writerWith({ dialogOpen: true });
    render(<ChatReport reports={reports} canWrite />);

    expect(screen.getByRole("button", { name: /^write report$/i })).toBeDisabled();
    expect(reports.write).not.toHaveBeenCalled();
  });

  it("says it is still writing, because this takes far longer than a reply", () => {
    render(<ChatReport reports={writerWith({ dialogOpen: true, pending: true })} canWrite />);

    expect(screen.getByRole("button", { name: /writing/i })).toBeDisabled();
  });

  it("opens when something else opened it — a bare /report typed in the composer", () => {
    // The dialog's open state lives on the writer rather than in here precisely
    // so the command can reach it: `/report` with nothing after it means "I want
    // a report and have not said what about", which is this dialog's question.
    render(<ChatReport reports={writerWith({ dialogOpen: true })} canWrite />);

    expect(screen.getByLabelText(/what should the report cover/i)).toBeInTheDocument();
  });
});

describe("ChatReportReceipt", () => {
  it("shows nothing until a report has been written", () => {
    const { container } = render(<ChatReportReceipt reports={writerWith()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("says a new report is not retrievable yet", () => {
    // A report is born with no chunks on purpose. Saying so here is what stops
    // someone assuming the agent can now search a document it cannot.
    render(<ChatReportReceipt reports={writerWith({ receipt: receipt() })} />);

    expect(screen.getByText("Q3 Review.md")).toBeInTheDocument();
    expect(screen.getByText(/not indexed/i)).toBeInTheDocument();
  });

  it("hands the report over when asked for it", async () => {
    const user = userEvent.setup();
    const reports = writerWith({ receipt: receipt() });
    render(<ChatReportReceipt reports={reports} />);

    await user.click(screen.getByRole("button", { name: /download q3 review\.md/i }));

    expect(reports.download).toHaveBeenCalled();
  });
});
