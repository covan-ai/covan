import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageSection } from "./usage-section";
import type { CreditSnapshot, UsageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { usage: vi.fn() } }));

// `CreditsWall` reads `["me"]` and its form writes through `useMutation` — none
// of which this file's blanket `useQuery` mock can support. Its own contract is
// in `credits-wall.test.tsx`; this file only needs to know whether
// `UsageSection` decided to render it.
vi.mock("@/components/credits-wall", () => ({
  CreditsWall: () => <div data-testid="credits-wall" />,
}));

const TOTALS = {
  messageCount: 10,
  promptTokens: 30_000,
  completionTokens: 7_000,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 37_000,
  estCostUsd: 0.2,
};

function usage(credits: CreditSnapshot): UsageResponse {
  return { agents: [], totals: TOTALS, credits };
}

const metered = (balance: number, over: Partial<Extract<CreditSnapshot, { metered: true }>> = {}) =>
  usage({
    metered: true,
    balance,
    granted: 500,
    spent: 500 - balance,
    unlimited: false,
    replies: 20,
    ...over,
  });

function renderWith(data: UsageResponse) {
  useQuery.mockImplementation(() => ({ data, isLoading: false, isPending: false }));
  render(<UsageSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("UsageSection", () => {
  it("shows the workspace's balance against what it was given", () => {
    renderWith(metered(412.7));

    expect(screen.getByText("Workspace credits")).toBeInTheDocument();
    expect(screen.getByText(/412 of 500/)).toBeInTheDocument();
    expect(screen.getByText(/replies left/)).toBeInTheDocument();
    // What a credit is, said on the screen that shows them.
    expect(screen.getByText(/A credit is a quarter of a cent/)).toBeInTheDocument();
  });

  it("offers the way out only once the credits are actually spent", () => {
    renderWith(metered(0));

    expect(screen.getByText(/Out of credits/)).toBeInTheDocument();
    expect(screen.getByTestId("credits-wall")).toBeInTheDocument();
  });

  it("does not send somebody away while there are credits left", () => {
    renderWith(metered(120));

    expect(screen.queryByTestId("credits-wall")).not.toBeInTheDocument();
  });

  it("never mentions a reset, because credits do not reset", () => {
    renderWith(metered(10));

    expect(screen.queryByText(/resets/)).not.toBeInTheDocument();
  });

  it("shows no credits at all on an install that does not meter", () => {
    renderWith(usage({ metered: false }));

    expect(screen.queryByText("Workspace credits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credits-wall")).not.toBeInTheDocument();
  });

  it("shows no balance for a house workspace", () => {
    renderWith(metered(0, { unlimited: true }));

    expect(screen.queryByText("Workspace credits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credits-wall")).not.toBeInTheDocument();
  });
});
