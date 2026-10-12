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
vi.mock("@/lib/api-client", () => ({ api: { me: () => Promise.resolve(me) } }));
vi.mock("@/components/usage-section", () => ({ UsageSection: stub("yours") }));
vi.mock("@/components/workspace-usage-section", () => ({
  WorkspaceUsageSection: stub("workspace"),
}));

const { Route } = await import("./_authed.settings.usage");

beforeEach(() => {
  me = meFixture();
});

describe("/settings/usage", () => {
  it("shows an admin their own figures and then the workspace's", async () => {
    renderRoute(Route);
    const workspace = await screen.findByTestId("workspace");
    const yours = screen.getByTestId("yours");
    expect(
      yours.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows anybody else only their own", async () => {
    me = meFixture({ role: "member" });
    renderRoute(Route);
    expect(screen.getByTestId("yours")).toBeInTheDocument();
    // Settle the query before asserting an absence, or this passes on the
    // loading render alone.
    await screen.findByText(/cost/);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  });
});
