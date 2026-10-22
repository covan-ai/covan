import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { Me } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => ({}),
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

let me: Me;
vi.mock("@/lib/api-client", () => ({
  api: { me: () => Promise.resolve(me), workspace: { update: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/export-workspace-section", () => ({
  ExportWorkspaceSection: () => <div data-testid="export" />,
}));
vi.mock("@/components/recently-deleted-section", () => ({
  RecentlyDeletedSection: ({ canWrite }: { canWrite: boolean }) =>
    canWrite ? <div data-testid="recently-deleted" /> : null,
}));

const { Route } = await import("./_authed.settings.export");

beforeEach(() => {
  me = meFixture();
});

describe("/settings/export", () => {
  it("offers the export and the trash to a member", async () => {
    me = meFixture({ role: "member" });
    renderRoute(Route);
    expect(await screen.findByTestId("export")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("recently-deleted")).toBeInTheDocument());
  });

  it("hides recently deleted from a viewer, whom the trash refuses anyway", async () => {
    me = meFixture({ role: "viewer" });
    renderRoute(Route);
    await screen.findByTestId("export");
    await waitFor(() => expect(screen.queryByTestId("recently-deleted")).not.toBeInTheDocument());
  });
});
