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
// The frame asks for the workspace name, which pulls in the API client and,
// under it, the Supabase client — which refuses to be built without a URL,
// and CI has none. Mocked at the API, which is the boundary the frame uses.
vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn().mockResolvedValue({ workspace: { name: "Acme" } }), feedback: {} },
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./_authed.settings");

describe("the settings page", () => {
  it("renders the page it is given under the top bar, the sub-nav, and the legal documents", () => {
    const Component = (Route as unknown as { component: () => React.ReactElement }).component;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    for (const page of [
      "General",
      "Members",
      "Integrations",
      "Profile",
      "Security",
      "Preferences",
    ]) {
      expect(nav).toHaveTextContent(page);
    }
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    expect(screen.getByText("Terms")).toBeInTheDocument();
    expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
  });
});
