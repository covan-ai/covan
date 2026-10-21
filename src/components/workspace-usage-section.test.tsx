import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceUsageSection } from "./workspace-usage-section";
import type { WorkspaceUsageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { workspaceUsage: vi.fn() } }));

// Whether this is the hosted service, which decides the unit every figure is
// in. Flipped per test; `creditsPhrase` and the rest stay real.
const hosted = { value: false };
vi.mock("@/lib/credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credits")>()),
  useIsHosted: () => hosted.value,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  hosted.value = false;
});

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

  it("says what a month cost, now that a reply records which model answered", () => {
    // covan#208. The trend showed tokens and nothing else, because `messages`
    // recorded no model and the only guess available was "assume every reply
    // came from whatever its agent is set to today". `0071` groups each bucket
    // by the model that actually answered.
    renderWith(
      response({
        months: [
          { month: "2026-07-01", messageCount: 0, totalTokens: 0, cachedTokens: 0, estCostUsd: 0 },
          {
            month: "2026-08-01",
            messageCount: 12,
            totalTokens: 120_000,
            cachedTokens: 0,
            estCostUsd: 3.5,
          },
        ],
      } as Partial<WorkspaceUsageResponse>),
    );

    expect(screen.getByText("$3.50")).toBeInTheDocument();
    expect(screen.getByText(/Aug: 120000 tokens across 12 replies, \$3\.50/)).toBeInTheDocument();
  });

  it("shows a month no cost at all rather than a free one", () => {
    // Against an API or a database without `0071` the field is absent, and
    // absent means "not known". A `$0.00` under a month with 120,000 tokens in
    // it would be a claim.
    renderWith(response());

    // `$1.40` is the agent row's and stays. What must not appear is a figure
    // for a month, and the readable version of the trend is where to check it.
    expect(screen.queryByText(/^\$0\.00$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Aug: 120000 tokens across 12 replies$/)).toBeInTheDocument();
  });

  it("reads a month that really spent nothing as nothing", () => {
    // `<$0.01` means "too small to print". A month with no replies in it spent
    // zero, and saying "<$0.01" there claims money moved.
    renderWith(
      response({
        months: [
          { month: "2026-07-01", messageCount: 0, totalTokens: 0, cachedTokens: 0, estCostUsd: 0 },
        ],
      } as Partial<WorkspaceUsageResponse>),
    );

    expect(screen.getByText(/Jul: 0 tokens across 0 replies, \$0\.00/)).toBeInTheDocument();
  });

  it("leaves the trend out when there is no history to draw", () => {
    renderWith(response({ months: [] }));

    expect(screen.queryByText(/last .* months/i)).not.toBeInTheDocument();
    expect(screen.getByText("The workspace")).toBeInTheDocument();
  });
});

describe("on the hosted service, where the unit is credits", () => {
  beforeEach(() => {
    hosted.value = true;
  });

  it("prices agents and months in credits, and never in dollars", () => {
    renderWith(
      response({
        agents: [{ ...AGENT, cacheWriteTokens: 0, estCredits: 1680 }],
        months: [
          {
            month: "2026-07-01",
            messageCount: 0,
            totalTokens: 0,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            estCostUsd: 0,
            estCredits: 0,
          },
          {
            month: "2026-08-01",
            messageCount: 12,
            totalTokens: 120_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            estCostUsd: 1.4,
            estCredits: 1680,
          },
        ],
      }),
    );

    expect(screen.getAllByText("1,680 credits").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\$/);
    expect(screen.getByText(/in credits at today's rate/)).toBeInTheDocument();
    expect(screen.getByText(/the ledger below is what was actually charged/)).toBeInTheDocument();
  });

  it("shows no money for a row the API has not quoted, rather than dollars", () => {
    renderWith(response({ agents: [{ ...AGENT, cacheWriteTokens: 0 }] }));

    expect(screen.queryByText("$1.40")).toBeNull();
    expect(screen.getByText("GTM Agent")).toBeInTheDocument();
  });

  it("no longer claims a reply does not record its model", () => {
    renderWith(response());

    expect(screen.queryByText(/does not record which model/)).toBeNull();
    expect(screen.getByText(/priced by the model that wrote it/)).toBeInTheDocument();
  });
});
