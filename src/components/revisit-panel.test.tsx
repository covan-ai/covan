import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The factory is hoisted above every top-level binding in this file, so the
// mock has to create the spy itself and the test reaches it back through the
// module. A `const` declared here would not exist yet when the factory runs.
vi.mock("@/lib/api-client", () => ({ api: { bundles: { citations: vi.fn() } } }));

import { api } from "@/lib/api-client";
import { RevisitPanel } from "./revisit-panel";

const citations = api.bundles.citations as unknown as ReturnType<typeof vi.fn>;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => Date.now() - n * DAY;

const doc = (id: string, name: string, days: number) => ({ id, name, createdAt: daysAgo(days) });

function renderPanel(documents: ReturnType<typeof doc>[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RevisitPanel documents={documents} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  citations.mockReset();
});

describe("RevisitPanel", () => {
  it("names the documents worth going back to, worst first", async () => {
    citations.mockResolvedValue({
      since: Date.UTC(2026, 7, 24),
      counts: { onboarding: 41, pricing: 12 },
    });
    renderPanel([doc("onboarding", "onboarding.pdf", 280), doc("pricing", "pricing-v2.md", 210)]);

    await waitFor(() => expect(screen.getByText("Worth revisiting")).toBeInTheDocument());

    const names = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("onboarding.pdf");
    expect(names[0]).toContain("41 answers");
    expect(names[1]).toContain("pricing-v2.md");
  });

  it("says nothing at all when nothing qualifies", async () => {
    // No heading, no empty state, no "0 documents need attention". A panel that
    // is always on screen stops being read, and this one has to be read on the
    // days it appears.
    citations.mockResolvedValue({ since: Date.UTC(2026, 7, 24), counts: { fresh: 90 } });
    renderPanel([doc("fresh", "written-last-week.md", 3)]);

    await waitFor(() => expect(citations).toHaveBeenCalled());
    expect(screen.queryByText("Worth revisiting")).not.toBeInTheDocument();
  });

  it("stays quiet for an old document nothing asks about", async () => {
    citations.mockResolvedValue({ since: Date.UTC(2026, 7, 24), counts: {} });
    renderPanel([doc("ancient", "someone-else-problem.md", 900)]);

    await waitFor(() => expect(citations).toHaveBeenCalled());
    expect(screen.queryByText("Worth revisiting")).not.toBeInTheDocument();
  });

  it("says what the count is and is not", async () => {
    // A number invites more trust than it has earned. A citation means the
    // document was searched and admitted, not that a word of it reached the
    // model — the context budget cuts documents that are still cited.
    citations.mockResolvedValue({ since: Date.UTC(2026, 7, 24), counts: { old: 5 } });
    renderPanel([doc("old", "stale.md", 400)]);

    await waitFor(() => expect(screen.getByText("Worth revisiting")).toBeInTheDocument());
    expect(screen.getByText(/cited a document, not of answers it changed/i)).toBeInTheDocument();
    expect(screen.getByText(/Counting answers since Aug 24, 2026/)).toBeInTheDocument();
  });

  it("leaves the window out rather than inventing one", async () => {
    // `since` is null when no reply has ever been countable. Printing a date
    // there would be a claim about data that does not exist.
    citations.mockResolvedValue({ since: null, counts: { old: 5 } });
    renderPanel([doc("old", "stale.md", 400)]);

    await waitFor(() => expect(screen.getByText("Worth revisiting")).toBeInTheDocument());
    expect(screen.queryByText(/Counting answers since/)).not.toBeInTheDocument();
  });

  it("shows nothing while the count is still on its way", () => {
    citations.mockReturnValue(new Promise(() => {}));
    renderPanel([doc("old", "stale.md", 400)]);

    // Not a skeleton. An empty region that later fills with a warning is fine;
    // a warning-shaped skeleton that resolves to nothing is a false alarm.
    expect(screen.queryByText("Worth revisiting")).not.toBeInTheDocument();
  });
});
