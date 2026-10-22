import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { CreditLedgerEntry } from "@/lib/api-client";

const h = vi.hoisted(() => ({
  hosted: true as boolean | undefined,
  creditLedger: vi.fn(),
  creditLedgerCsv: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { creditLedger: h.creditLedger, creditLedgerCsv: h.creditLedgerCsv },
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/credits", () => ({ useIsHosted: () => h.hosted }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CreditLedger } from "./credit-ledger";

const row = (over: Partial<CreditLedgerEntry>): CreditLedgerEntry => ({
  id: 1,
  at: new Date().toISOString(),
  kind: "completion",
  model: "gpt-4o",
  purpose: "reply",
  credits: -42,
  balanceAfter: 1240,
  note: null,
  sessionId: null,
  ...over,
});

function renderLedger() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CreditLedger />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hosted = true;
});

describe("CreditLedger", () => {
  it("names each charge by its thread or routine, its agent and who started it", async () => {
    h.creditLedger.mockResolvedValue({
      hasMore: false,
      entries: [
        row({
          id: 3,
          sessionId: "s1",
          sessionTitle: "Onboarding email draft",
          agentId: "a1",
          agentName: "Support",
          by: { kind: "person", name: "Mina Kaya" },
        }),
        row({
          id: 2,
          routineId: "r1",
          routineName: "Weekly competitor brief",
          agentName: "Research",
          by: { kind: "routine" },
          credits: -18,
        }),
        row({ id: 1, kind: "purchase", purpose: null, credits: 10_000 }),
      ],
    });
    renderLedger();

    const table = await screen.findByRole("table", { name: /credit ledger/i });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent(/Onboarding email draft.*Support.*Mina.*−42/);
    expect(rows[1]).toHaveTextContent(/Weekly competitor brief.*Research.*Routine.*−18/);
    expect(rows[2]).toHaveTextContent(/Bought 10,000 credits.*\+10,000/);
  });

  it("lists somebody's private thread by its cost, not its title", async () => {
    h.creditLedger.mockResolvedValue({
      hasMore: false,
      entries: [row({ sessionId: "s-private", purpose: "title", credits: -0.2 })],
    });
    renderLedger();
    const table = await screen.findByRole("table", { name: /credit ledger/i });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      /A private thread · Thread title.*−0\.20/,
    );
  });

  it("loads older rows from the last one shown", async () => {
    const user = userEvent.setup();
    h.creditLedger
      .mockResolvedValueOnce({ hasMore: true, entries: [row({ id: 9 })] })
      .mockResolvedValueOnce({ hasMore: false, entries: [row({ id: 4, credits: -7 })] });
    renderLedger();

    await user.click(await screen.findByRole("button", { name: /show older/i }));
    await waitFor(() => expect(h.creditLedger).toHaveBeenLastCalledWith({ limit: 50, before: 9 }));
    expect(await screen.findByText("−7")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show older/i })).not.toBeInTheDocument();
  });

  it("exports the whole ledger as CSV", async () => {
    const user = userEvent.setup();
    h.creditLedger.mockResolvedValue({ hasMore: false, entries: [row({})] });
    h.creditLedgerCsv.mockResolvedValue(undefined);
    renderLedger();
    await user.click(await screen.findByRole("button", { name: /export csv/i }));
    expect(h.creditLedgerCsv).toHaveBeenCalled();
  });

  it("renders nothing on an install that keeps no ledger", () => {
    h.hosted = false;
    const { container } = renderLedger();
    expect(container).toBeEmptyDOMElement();
    expect(h.creditLedger).not.toHaveBeenCalled();
  });
});
