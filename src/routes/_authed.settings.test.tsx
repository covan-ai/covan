import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Outlet: () => <div data-testid="outlet" />,
  useRouterState: () => "/settings/account",
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./_authed.settings");

describe("the settings frame", () => {
  it("renders the page it is given, the rail, and the way back to the legal documents", () => {
    const Component = (Route as unknown as { component: () => React.ReactElement }).component;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Settings sections" });
    expect(rail).toHaveTextContent("Account");
    expect(rail).toHaveTextContent("Workspace");
    expect(screen.getByText("Terms")).toBeInTheDocument();
    expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
  });
});
