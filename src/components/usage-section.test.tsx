import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageSection } from "./usage-section";
import type { UsageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { usage: vi.fn(), providerKeys: { get: vi.fn() } } }));

// `QuotaWall` reads `["me"]` and `["provider-keys"]` and its own children write
// through `useMutation` — none of which this file's blanket `useQuery` mock (one
// answer for every query, whatever the key) can support. Its own contract has
// its own test, `quota-wall.test.tsx`; this file only needs to know whether
// `UsageSection` decided to render it.
vi.mock("@/components/quota-wall", () => ({
  QuotaWall: () => <div data-testid="quota-wall" />,
}));

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

function renderWith(
  data: UsageResponse,
  keys?: { openai: string | null; anthropic: string | null },
) {
  // `UsageSection` now runs two queries — `["usage"]` and `["provider-keys"]`
  // — so the old one-answer-for-every-call mock would hand the usage fixture
  // back as the key hints too. Dispatching on `queryKey[0]` is the same fix
  // `_authed.app.test.tsx` uses for the same shape of problem.
  useQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
    if (opts.queryKey[0] === "provider-keys") {
      return {
        data: keys ? { configured: true, updatedAt: null, ...keys } : undefined,
        isLoading: false,
        isPending: false,
      };
    }
    return { data, isLoading: false, isPending: false };
  });
  render(<UsageSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("UsageSection", () => {
  it("offers the way out only once the allowance is actually spent", () => {
    // The state nobody sees while building the thing: replies are paused and
    // there is no paid tier to sell, so the honest answer is the open build.
    renderWith(usage({ used: 200_000, limit: 200_000, resetsAt: "2026-09-01T00:00:00.000Z" }));

    expect(screen.getByText(/Used up/)).toBeInTheDocument();
    // The three answers themselves — the workspace's own key, a message to us,
    // self-hosting still — are `QuotaWall`'s contract, proven in
    // `quota-wall.test.tsx`. This only has to show up.
    expect(screen.getByTestId("quota-wall")).toBeInTheDocument();
  });

  it("does not send somebody away while they still have replies left", () => {
    renderWith(usage({ used: 1_000, limit: 200_000, resetsAt: "2026-09-01T00:00:00.000Z" }));

    expect(screen.queryByTestId("quota-wall")).not.toBeInTheDocument();
    expect(screen.getByText(/replies left/)).toBeInTheDocument();
  });

  it("says replies continue once an admin has set a workspace key", () => {
    // `/usage` (`entitlements.snapshot`) has no notion of a workspace provider
    // key at all, so this reads the same `["provider-keys"]` cache
    // `QuotaWall` populates rather than waiting on a response that structurally
    // cannot say replies continue.
    renderWith(usage({ used: 200_000, limit: 200_000, resetsAt: "2026-09-01T00:00:00.000Z" }), {
      openai: "sk-…4f2a",
      anthropic: null,
    });

    expect(screen.queryByText(/new replies are paused/)).not.toBeInTheDocument();
    expect(screen.getByText(/workspace's own key carries on from here/)).toBeInTheDocument();
  });

  it("shows no allowance at all on an install that does not meter", () => {
    // limit: null is how the API says "self-hosted". The whole card, including
    // the wall itself, would be nonsense to somebody already there.
    renderWith(usage({ used: 0, limit: null, resetsAt: null }));

    expect(screen.queryByText(/Used up/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("quota-wall")).not.toBeInTheDocument();
  });
});
