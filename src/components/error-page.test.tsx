import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouter: () => ({ invalidate: vi.fn() }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { href: "/agents/9f2a/chat?s=48213" } }),
}));
vi.mock("@/components/feedback-dialog", () => ({ FeedbackDialog: () => null }));

const { ErrorPage } = await import("./error-page");

describe("when something is wrong", () => {
  it("names the missing path and the two ways out", () => {
    render(<ErrorPage kind="not-found" />);
    expect(screen.getByRole("heading", { name: "There is nothing here" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/app");
    expect(screen.getByRole("link", { name: "Open the Inbox" })).toHaveAttribute("href", "/inbox");
    expect(screen.getByText("/agents/9f2a/chat?s=48213")).toBeInTheDocument();
  });

  it("gives a crash an id and a way to report it, never a stack", () => {
    render(<ErrorPage kind="error" errorId="err_7f3k2m9q" />);
    expect(
      screen.getByRole("heading", { name: "Something went wrong on this page" }),
    ).toBeInTheDocument();
    expect(screen.getByText("err_7f3k2m9q")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
  });
});
