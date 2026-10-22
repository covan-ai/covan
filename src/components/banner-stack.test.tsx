import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const queries: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queries[queryKey.join(":")] }),
  useQueryClient: () => ({ refetchQueries: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({ api: {} }));
const accept = vi.fn();
vi.mock("@/lib/accept-invitation", () => ({
  OPEN_THE_EMAIL: "Open the link in your invitation email to accept.",
  useAcceptInvitation: () => ({ accept, canAccept: () => true, busy: false }),
}));
let credits: unknown = null;
vi.mock("@/lib/credits", () => ({ useCredits: () => credits }));

const { BannerStack } = await import("./banner-stack");

beforeEach(() => {
  sessionStorage.clear();
  credits = null;
  queries.me = { workspace: { name: "Acme" } };
  queries["invitations:incoming"] = [
    {
      id: "i1",
      workspaceId: "w2",
      workspaceName: "Northwind Co.",
      inviterName: "Deniz",
      role: "member",
      createdAt: 1,
    },
  ];
});

describe("the banners over the page", () => {
  it("offers an invitation to another workspace, and Ignore puts it off", () => {
    render(<BannerStack />);
    expect(screen.getByText("Deniz invited you to Northwind Co.")).toBeInTheDocument();
    expect(
      screen.getByText(/as a Member\. Your Acme workspace is not affected\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(accept).toHaveBeenCalledWith("i1");
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(screen.queryByRole("region", { name: "Invitation" })).not.toBeInTheDocument();
  });

  it("says a low balance with the way to buy, and lets it be dismissed", () => {
    queries["invitations:incoming"] = [];
    credits = { balance: 200, level: "low", ratio: 0.1 };
    render(<BannerStack />);
    expect(screen.getByText("200 credits left.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy credits" })).toHaveAttribute(
      "href",
      "/settings/usage",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Credits" })).not.toBeInTheDocument();
  });

  it("says when the app is offline, first", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    credits = { balance: 200, level: "low", ratio: 0.1 };
    render(<BannerStack />);
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["Offline", "Invitation"]);
  });
});
