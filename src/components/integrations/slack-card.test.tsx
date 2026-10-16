import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlackCard } from "./slack-card";
import type { SlackState } from "@/lib/connections-api";

const { startInstall } = vi.hoisted(() => ({ startInstall: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-connections", () => ({
  useStartSlackInstall: () => ({ mutate: startInstall, isPending: false }),
  useSetSlackAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSlack: () => ({ mutate: vi.fn(), isPending: false }),
}));

const installed = (missingScopes?: string[]): SlackState => ({
  configured: true,
  installation: {
    id: "inst-1",
    teamName: "Acme",
    agentId: "a1",
    installedBy: "u1",
    createdAt: 0,
    missingScopes,
  },
});

beforeEach(() => startInstall.mockReset());

describe("SlackCard", () => {
  it("asks for a reconnect when the install cannot hear channel activity", async () => {
    const user = userEvent.setup();
    render(<SlackCard state={installed(["channels:history"])} agents={[]} />);

    expect(
      screen.getByText(/can't start on channel messages or reactions yet/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(startInstall).toHaveBeenCalledOnce();
  });

  it("says nothing about it for an install that has every scope", () => {
    render(<SlackCard state={installed([])} agents={[]} />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("says nothing about it to an API that does not report scopes", () => {
    render(<SlackCard state={installed(undefined)} agents={[]} />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });
});
