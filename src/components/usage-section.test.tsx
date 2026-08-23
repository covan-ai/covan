import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageSection } from "./usage-section";
import type { UsageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { usage: vi.fn() } }));

const TOTALS = {
  messageCount: 10,
  promptTokens: 30_000,
  completionTokens: 7_000,
  cachedTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 37_000,
  estCostUsd: 0.2,
};

function usage(quota: UsageResponse["quota"]): UsageResponse {
  return { agents: [], totals: TOTALS, quota } as UsageResponse;
}

function renderWith(data: UsageResponse) {
  useQuery.mockReturnValue({ data, isLoading: false, isPending: false });
  render(<UsageSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("UsageSection", () => {
  it("offers the way out only once the allowance is actually spent", () => {
    // The state nobody sees while building the thing: replies are paused and
    // there is no paid tier to sell, so the honest answer is the open build.
    renderWith(usage({ used: 200_000, limit: 200_000, resetsAt: "2026-09-01T00:00:00.000Z" }));

    expect(screen.getByText(/Used up/)).toBeInTheDocument();
    expect(screen.getByText(/no allowance at all/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /running it yourself/i })).toHaveAttribute(
      "href",
      "https://covan.app/docs/self-hosting",
    );
  });

  it("does not send somebody away while they still have replies left", () => {
    renderWith(usage({ used: 1_000, limit: 200_000, resetsAt: "2026-09-01T00:00:00.000Z" }));

    expect(screen.queryByText(/no allowance at all/)).not.toBeInTheDocument();
    expect(screen.getByText(/replies left/)).toBeInTheDocument();
  });

  it("shows no allowance at all on an install that does not meter", () => {
    // limit: null is how the API says "self-hosted". The whole card, including
    // the advice to self-host, would be nonsense to somebody already there.
    renderWith(usage({ used: 0, limit: null, resetsAt: null }));

    expect(screen.queryByText(/Used up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no allowance at all/)).not.toBeInTheDocument();
  });
});
