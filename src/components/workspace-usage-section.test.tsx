import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceUsageSection } from "./workspace-usage-section";
import type { WorkspaceUsageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { workspaceUsage: vi.fn() } }));

const TOTALS = {
  messageCount: 12,
  promptTokens: 90_000,
  completionTokens: 30_000,
  cachedTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 120_000,
  estCostUsd: 1.4,
};

const AGENT = {
  agentId: "agent-1",
  name: "GTM Agent",
  emoji: "📈",
  model: "gpt-4o",
  messageCount: 12,
  promptTokens: 90_000,
  completionTokens: 30_000,
  cachedTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 120_000,
  estCostUsd: 1.4,
};

const response = (patch: Partial<WorkspaceUsageResponse> = {}): WorkspaceUsageResponse =>
  ({
    available: true,
    agents: [AGENT],
    totals: TOTALS,
    months: [
      { month: "2026-07-01", messageCount: 0, totalTokens: 0, cachedTokens: 0 },
      { month: "2026-08-01", messageCount: 12, totalTokens: 120_000, cachedTokens: 0 },
    ],
    ...patch,
  }) as WorkspaceUsageResponse;

function renderWith(data: WorkspaceUsageResponse | undefined, isLoading = false) {
  useQuery.mockReturnValue({ data, isLoading, isPending: isLoading });
  render(<WorkspaceUsageSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("WorkspaceUsageSection", () => {
  it("shows what the workspace spent, by agent", () => {
    renderWith(response());

    expect(screen.getByText("GTM Agent")).toBeInTheDocument();
    expect(screen.getByText("$1.40")).toBeInTheDocument();
    expect(screen.getByText(/12 replies · gpt-4o/)).toBeInTheDocument();
  });

  // CI does not apply migrations, so there is a real window in which the API is
  // deployed and 0032 is not. An admin should see nothing at all there — an
  // error about a feature they never asked for is worse than the feature's
  // absence.
  it("renders nothing at all until the migration behind it exists", () => {
    renderWith(response({ available: false }));

    expect(screen.queryByText("The workspace")).not.toBeInTheDocument();
  });

  it("renders nothing while it is still loading, rather than an empty shell", () => {
    renderWith(undefined, true);

    expect(screen.queryByText("The workspace")).not.toBeInTheDocument();
  });

  // Token counts are not conversation content, but a table of who spent what is
  // the wrong thing to put in a product that promises private rooms. The
  // functions in 0032 do not return a user_id, so there is nothing to render —
  // this asserts the promise the heading makes out loud.
  it("says out loud that nothing here is per-person", () => {
    renderWith(response());

    expect(screen.getByText(/never by person/i)).toBeInTheDocument();
    expect(screen.getByText(/no view that does/i)).toBeInTheDocument();
  });

  it("keeps a month nobody used as a month, not a gap", () => {
    renderWith(response());

    // Both buckets are labelled and read out, including the empty one. A chart
    // that closes up a quiet month makes a fall in spend look like a flat line.
    expect(screen.getByText("Jul")).toBeInTheDocument();
    expect(screen.getByText("Aug")).toBeInTheDocument();
    expect(screen.getByText(/Jul: 0 tokens across 0 replies/)).toBeInTheDocument();
  });

  it("leaves the trend out when there is no history to draw", () => {
    renderWith(response({ months: [] }));

    expect(screen.queryByText(/last .* months/i)).not.toBeInTheDocument();
    expect(screen.getByText("The workspace")).toBeInTheDocument();
  });
});
