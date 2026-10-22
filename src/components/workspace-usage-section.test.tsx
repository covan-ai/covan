import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentUsage, UsageResponse, WorkspaceUsageResponse } from "@/lib/api-client";

const h = vi.hoisted(() => ({ usage: vi.fn(), workspaceUsage: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: { usage: h.usage, workspaceUsage: h.workspaceUsage },
}));

import { WorkspaceUsageSection } from "./workspace-usage-section";

const TOTALS = {
  messageCount: 12,
  promptTokens: 90_000,
  completionTokens: 30_000,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 120_000,
  estCostUsd: 1.4,
};

const agent = (over: Partial<AgentUsage>): AgentUsage =>
  ({
    agentId: "agent-1",
    name: "Support",
    emoji: null,
    model: "gpt-4o",
    messageCount: 12,
    promptTokens: 90_000,
    completionTokens: 30_000,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    measuredPromptTokens: 0,
    totalTokens: 120_000,
    estCostUsd: 1.4,
    ...over,
  }) as AgentUsage;

const own: UsageResponse = {
  agents: [agent({ name: "Mine only", estCostUsd: 0.004 })],
  totals: TOTALS,
  credits: { metered: false },
};

const everyone = (patch: Partial<WorkspaceUsageResponse> = {}): WorkspaceUsageResponse => ({
  available: true,
  agents: [agent({}), agent({ agentId: "agent-2", name: "Quiet", messageCount: 0 })],
  totals: TOTALS,
  months: [],
  ...patch,
});

function renderSection(isAdmin: boolean) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceUsageSection isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.usage.mockResolvedValue(own);
  h.workspaceUsage.mockResolvedValue(everyone());
});

describe("WorkspaceUsageSection", () => {
  it("shows an admin everyone's figures by agent, in dollars, and says never by person", async () => {
    renderSection(true);
    expect(await screen.findByText("Support")).toBeInTheDocument();
    expect(screen.getByText("$1.40")).toBeInTheDocument();
    expect(screen.getByText("120k")).toBeInTheDocument();
    // An agent nobody used is not a row of zeros.
    expect(screen.queryByText("Quiet")).not.toBeInTheDocument();
    expect(screen.getByText(/never by person/i)).toBeInTheDocument();
  });

  it("shows anybody else their own, and says so", async () => {
    renderSection(false);
    expect(await screen.findByText("Mine only")).toBeInTheDocument();
    expect(screen.getByText("<$0.01")).toBeInTheDocument();
    expect(screen.getByText(/your own conversations/i)).toBeInTheDocument();
    expect(h.workspaceUsage).not.toHaveBeenCalled();
  });

  it("falls back to an admin's own figures before the workspace read exists", async () => {
    h.workspaceUsage.mockResolvedValue(everyone({ available: false, agents: [] }));
    renderSection(true);
    expect(await screen.findByText("Mine only")).toBeInTheDocument();
  });

  it("says nothing has been used yet rather than drawing an empty table", async () => {
    h.workspaceUsage.mockResolvedValue(everyone({ agents: [] }));
    renderSection(true);
    expect(await screen.findByText(/once anybody talks to an agent/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
