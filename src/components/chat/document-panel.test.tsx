import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DocumentJob } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ api: {} }));
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
});
