import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingSettings, UsageMonthByAgent } from "@/lib/api-client";
import type { CreditsView } from "@/lib/credits";

const h = vi.hoisted(() => ({
  credits: null as CreditsView | null,
  usageMonth: vi.fn(),
  settings: vi.fn(),
  updateSettings: vi.fn(),
  invoices: vi.fn(),
  invoicePdfUrl: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    usageMonth: h.usageMonth,
    billing: {
      settings: h.settings,
      updateSettings: h.updateSettings,
      invoices: h.invoices,
      invoicePdfUrl: h.invoicePdfUrl,
    },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credits")>()),
  useCredits: () => h.credits,
}));
// Its own contract is in `credits-wall.test.tsx`; here only whether it is drawn.
vi.mock("@/components/credits-wall", () => ({
  CreditsWall: () => <div data-testid="credits-wall" />,
}));

import { UsageSection } from "./usage-section";

const credits = (over: Partial<CreditsView> = {}): CreditsView => ({
  balance: 1240,
  granted: 2200,
  ratio: 0.56,
  perReply: 2,
  repliesLeft: 620,
  repliesSeen: 40,
  repliesKnown: true,
  level: "fine",
  ...over,
});

const MONTH: UsageMonthByAgent = {
  available: true,
  since: "2026-10-01",
  unit: "credits",
  spent: 760,
  byAgent: [
    { agentId: "a1", name: "Support", avatar: "headset", amount: 310 },
    { agentId: "a2", name: "Research", avatar: "owl", amount: 240 },
  ],
};

const SETTINGS: BillingSettings = {
  autoTopUp: { available: false, enabled: false, below: 200, amount: 10_000 },
  lowBalance: { enabled: true, below: 200 },
  card: { brand: "visa", last4: "4242" },
};

function renderSection(isAdmin = true) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UsageSection isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.credits = credits();
  h.usageMonth.mockResolvedValue(MONTH);
  h.settings.mockResolvedValue({ available: true, ...SETTINGS });
  h.invoices.mockResolvedValue({
    available: true,
    invoices: [
      { id: "inv-1", at: "2026-10-20T09:00:00Z", credits: 10_000, total: "$25.00", status: "paid" },
    ],
  });
});

describe("UsageSection", () => {
  it("shows what is left and what this month has used", async () => {
    renderSection();
    expect(screen.getByText("1,240")).toBeInTheDocument();
    expect(await screen.findByText("760 used this month")).toBeInTheDocument();
    expect(screen.getByText(/about 620 replies left/i)).toBeInTheDocument();
  });

  it("never mentions a reset, because credits do not reset", async () => {
    renderSection();
    await screen.findByText("760 used this month");
    expect(screen.queryByText(/reset/i)).not.toBeInTheDocument();
  });

  it("lists this month by agent and the invoices for an admin", async () => {
    renderSection();
    expect(
      await screen.findByRole("list", { name: /credits this month by agent/i }),
    ).toHaveTextContent(/Support.*310.*Research.*240/);
    expect(await screen.findByText("October 2026")).toBeInTheDocument();
    expect(screen.getByText("10,000 credits · $25.00")).toBeInTheDocument();
  });

  it("asks nothing a member may not read, and lets them see but not change the switches", async () => {
    renderSection(false);
    await screen.findByText(/card ending 4242/i);
    expect(h.usageMonth).not.toHaveBeenCalled();
    expect(h.invoices).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: /low balance warning/i })).toBeDisabled();
    // Without the month, the bar is what is used of everything ever added.
    expect(screen.getByText("960 used of 2,200 added")).toBeInTheDocument();
  });

  it("shows auto top-up as coming soon until the provider can charge a saved card", async () => {
    renderSection();
    expect(await screen.findByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /auto top-up/i })).toBeDisabled();
  });

  it("saves the low-balance switch", async () => {
    const user = userEvent.setup();
    h.updateSettings.mockResolvedValue({
      available: true,
      ...SETTINGS,
      lowBalance: { enabled: false, below: 200 },
    });
    renderSection();
    await user.click(await screen.findByRole("switch", { name: /low balance warning/i }));
    await waitFor(() =>
      expect(h.updateSettings).toHaveBeenCalledWith({ lowBalance: { enabled: false } }),
    );
  });

  it("leaves the paying rows out where the deployment sells no credits", async () => {
    h.settings.mockResolvedValue({ available: false });
    h.invoices.mockResolvedValue({ available: false });
    renderSection();
    await screen.findByText("760 used this month");
    expect(screen.queryByText(/auto top-up/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Invoices")).not.toBeInTheDocument();
  });

  it("offers the way out only once the credits are actually spent", () => {
    h.credits = credits({ balance: 0, level: "spent", repliesLeft: 0 });
    renderSection();
    expect(screen.getByTestId("credits-wall")).toBeInTheDocument();
    expect(screen.getByText(/out of credits/i)).toBeInTheDocument();
  });

  it("does not send somebody away while there are credits left", () => {
    renderSection();
    expect(screen.queryByTestId("credits-wall")).not.toBeInTheDocument();
  });

  it("shows no balance for a house workspace", () => {
    h.credits = null;
    renderSection();
    expect(screen.queryByText(/credits left/i)).not.toBeInTheDocument();
  });
});
