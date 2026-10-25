import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentJob } from "@/lib/api-client";
import { ANSWER_EVENT, type AnswerAction } from "@/lib/answer-events";

const download = vi.fn();
const exportDocument = vi.fn();
vi.mock("@/lib/api-client", () => ({ api: { documents: { download, export: exportDocument } } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { DocumentPanel } = await import("./document-panel");

const job: DocumentJob = {
  id: "job-1",
  agentId: "agent-1",
  sessionId: "sess-1",
  bundleId: "bundle-1",
  origin: "tool",
  instruction: "Write it up.",
  title: "Q3",
  status: "ready",
  written: 2,
  total: 2,
  documentId: "doc-1",
  error: null,
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  finishedAt: "2026-10-15T12:03:00.000Z",
  sections: [
    { index: 0, heading: "Revenue", body: "Up.", done: true },
    { index: 1, heading: "Risks", body: "Few.", done: true },
  ],
};

describe("DocumentPanel", () => {
  it("scrolls the document inside itself, not the page behind it", () => {
    // jsdom lays nothing out, so this pins the three classes that make it
    // true in a browser: the panel held to its height, the body allowed to
    // shrink below its content, and a scroll that stops at the panel's edge.
    const { container } = render(
      <DocumentPanel job={job} onClose={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} />,
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toMatch(/\bmin-h-0\b/);
    expect(panel.className).toMatch(/\boverflow-hidden\b/);

    const scroller = screen.getByTestId("document-scroll");
    expect(scroller.className).toMatch(/\bmin-h-0\b/);
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroller.className).toMatch(/\boverscroll-contain\b/);
  });

  it("names who wrote it and where it is filed, and offers the file once it is filed", () => {
    render(
      <DocumentPanel
        job={job}
        agent={{ name: "Research", avatar: "owl" }}
        folderName="Reports / Competitor briefs"
        onClose={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Q3" })).toBeInTheDocument();
    expect(screen.getByText("Reports / Competitor briefs")).toBeInTheDocument();
    expect(screen.getByText(/^Written by Research · /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument();
  });

  it("offers Stop while it is being written, and no file yet", () => {
    render(
      <DocumentPanel
        job={{ ...job, status: "writing", written: 1, documentId: null }}
        onClose={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
  });

  it("announces a save once, with the format chosen and the document it belongs to", async () => {
    // The job carries no message id, so the document's own is what goes out.
    const heard: AnswerAction[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent<AnswerAction>).detail);
    window.addEventListener(ANSWER_EVENT, listener);
    exportDocument.mockResolvedValue("saved");
    try {
      render(<DocumentPanel job={job} onClose={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} />);

      await userEvent.click(screen.getByRole("button", { name: /Download/ }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Word" }));

      expect(heard).toEqual([{ action: "saved", documentId: "doc-1", format: "docx" }]);
      expect(exportDocument).toHaveBeenCalledWith("doc-1", "docx");
    } finally {
      window.removeEventListener(ANSWER_EVENT, listener);
    }
  });

  it("saves all the same when a listener throws", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = (e: Event) => e.preventDefault();
    const throwing = () => {
      throw new Error("boom");
    };
    window.addEventListener("error", onError);
    window.addEventListener(ANSWER_EVENT, throwing);
    exportDocument.mockResolvedValue("saved");
    try {
      render(<DocumentPanel job={job} onClose={vi.fn()} onStop={vi.fn()} onRetry={vi.fn()} />);

      await userEvent.click(screen.getByRole("button", { name: /Download/ }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "PDF" }));

      expect(exportDocument).toHaveBeenCalledWith("doc-1", "pdf");
    } finally {
      window.removeEventListener(ANSWER_EVENT, throwing);
      window.removeEventListener("error", onError);
      quiet.mockRestore();
    }
  });
});
