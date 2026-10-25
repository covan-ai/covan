import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/** Routines with none yet: what one is, and where to find one worth having (0139). */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Navigate: () => null,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/lib/api-client", () => ({ api: { routines: { list: vi.fn(async () => []) } } }));

describe("the routines page with none yet", () => {
  it("points at what arrives in the person's inbox", async () => {
    const { Route } = await import("./_authed.routines.index");
    const Component = (Route as unknown as { component: () => React.ReactElement }).component;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>,
    );
    const link = await screen.findByRole("link", { name: "See what arrives in your inbox" });
    expect(link.getAttribute("href")).toBe("/arrivals");
  });
});
