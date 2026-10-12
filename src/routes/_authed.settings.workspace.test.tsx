import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { Me } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
}));

let me: Me;
vi.mock("@/lib/api-client", () => ({
  api: { me: () => Promise.resolve(me), workspace: { update: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/preferences-section", () => ({
  DefaultModelSection: () => <div data-testid="default-model" />,
}));
vi.mock("@/components/workspace-coverage-section", () => ({
  WorkspaceCoverageSection: () => <div data-testid="coverage" />,
}));
vi.mock("@/components/export-workspace-section", () => ({
  ExportWorkspaceSection: () => <div data-testid="export" />,
}));
vi.mock("@/components/recently-deleted-section", () => ({
  RecentlyDeletedSection: ({ canWrite }: { canWrite: boolean }) =>
    canWrite ? <div data-testid="recently-deleted" /> : null,
}));

const { Route } = await import("./_authed.settings.workspace");

beforeEach(() => {
  me = meFixture();
});

describe("/settings/workspace", () => {
  it("lets an admin change the name and see the coverage report", async () => {
    renderRoute(Route);
    const name = await screen.findByDisplayValue("Acme");
    expect(name).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByTestId("coverage")).toBeInTheDocument();
    expect(screen.getByTestId("default-model")).toBeInTheDocument();
    expect(screen.getByTestId("export")).toBeInTheDocument();
  });

  it("shows a member the workspace without offering what an admin decides", async () => {
    me = meFixture({ role: "member" });
    renderRoute(Route);
    const name = await screen.findByDisplayValue("Acme");
    await waitFor(() => expect(name).toBeDisabled());
    expect(screen.getByText("The name and slug are an admin's to change.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("coverage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("default-model")).not.toBeInTheDocument();
    expect(screen.getByTestId("recently-deleted")).toBeInTheDocument();
  });

  it("hides recently deleted from a viewer, whom the trash refuses anyway", async () => {
    me = meFixture({ role: "viewer" });
    renderRoute(Route);
    await screen.findByText("The name and slug are an admin's to change.");
    expect(screen.queryByTestId("recently-deleted")).not.toBeInTheDocument();
  });
});
