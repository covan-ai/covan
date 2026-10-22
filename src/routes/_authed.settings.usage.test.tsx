import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type React from "react";
import type { Me } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute, stub } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
}));

let me: Me;
let hosted: boolean | undefined;
vi.mock("@/lib/api-client", () => ({ api: { me: () => Promise.resolve(me) } }));
vi.mock("@/lib/credits", () => ({ useIsHosted: () => hosted }));
vi.mock("@/components/usage-section", () => ({ UsageSection: stub("balance") }));
vi.mock("@/components/credit-ledger", () => ({ CreditLedger: stub("ledger") }));
vi.mock("@/components/workspace-usage-section", () => ({
  WorkspaceUsageSection: stub("by-agent"),
}));

const { Route } = await import("./_authed.settings.usage");

beforeEach(() => {
  me = meFixture();
  hosted = true;
});

describe("/settings/usage", () => {
  it("shows an admin on the hosted service the balance, then the ledger", async () => {
    renderRoute(Route);
    const ledger = await screen.findByTestId("ledger");
    expect(
      screen.getByTestId("balance").compareDocumentPosition(ledger) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/credits are the only unit/i)).toBeInTheDocument();
    expect(screen.queryByTestId("by-agent")).not.toBeInTheDocument();
  });

  it("shows a member the balance and not the ledger", async () => {
    me = meFixture({ role: "member" });
    renderRoute(Route);
    expect(screen.getByTestId("balance")).toBeInTheDocument();
    // Settle `me` before asserting an absence, or this passes on the loading
    // render alone (which treats everyone as an admin until it knows).
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(screen.queryByTestId("ledger")).not.toBeInTheDocument());
  });

  it("shows an install that charges nobody one table by agent and no credits", () => {
    hosted = false;
    renderRoute(Route);
    expect(screen.getByTestId("by-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("balance")).not.toBeInTheDocument();
    expect(screen.getByText(/nothing here is billed/i)).toBeInTheDocument();
  });
});
