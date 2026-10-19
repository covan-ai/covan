import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CreditSnapshot, UsageResponse } from "@/lib/api-client";
import { CreditsBadge } from "./credits-badge";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { usage: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const TOTALS = {
  messageCount: 0,
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  measuredPromptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estCostUsd: 0,
};

function renderWith(credits: CreditSnapshot) {
  const data: UsageResponse = { agents: [], totals: TOTALS, credits };
  useQuery.mockReturnValue({ data });
  return render(<CreditsBadge />);
}

const metered = (over: Partial<Extract<CreditSnapshot, { metered: true }>>) =>
  ({
    metered: true,
    balance: 412.7,
    granted: 500,
    spent: 87.3,
    unlimited: false,
    replies: 10,
    ...over,
  }) as CreditSnapshot;

beforeEach(() => vi.clearAllMocks());

describe("CreditsBadge", () => {
  it("shows the balance in whole credits", () => {
    renderWith(metered({}));
    expect(screen.getByText("412 credits")).toBeInTheDocument();
  });

  it("says Unlimited for a house workspace", () => {
    renderWith(metered({ unlimited: true, balance: 0 }));
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
  });

  it("does not call half a credit zero", () => {
    renderWith(metered({ balance: 0.5 }));
    expect(screen.getByText("<1 credit")).toBeInTheDocument();
  });

  it("never shows a negative balance", () => {
    renderWith(metered({ balance: -0.4, spent: 500.4 }));
    expect(screen.getByText("0 credits")).toBeInTheDocument();
  });

  it("renders nothing on a self-hosted install", () => {
    const { container } = renderWith({ metered: false });
    expect(container).toBeEmptyDOMElement();
  });
});
