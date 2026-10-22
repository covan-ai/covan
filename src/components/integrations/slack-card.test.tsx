import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlackCard, SlackRow } from "./slack-card";
import type { SlackState } from "@/lib/connections-api";
import type { Agent } from "@/lib/agents-store";

const { startInstall } = vi.hoisted(() => ({ startInstall: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-connections", () => ({
  useStartSlackInstall: () => ({ mutate: startInstall, isPending: false }),
  useSetSlackAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSlack: () => ({ mutate: vi.fn(), isPending: false }),
}));

const installation = (missingScopes?: string[]) => ({
  id: "inst-1",
  teamName: "Acme",
  agentId: "a1",
  installedBy: "u1",
  createdAt: 0,
  missingScopes,
});

const AGENTS = [{ id: "a1", name: "Support" }] as Agent[];

async function manage(missingScopes?: string[]) {
  const user = userEvent.setup();
  render(
    <SlackRow installation={installation(missingScopes)} agents={AGENTS} installedBy="Deniz" />,
  );
  await user.click(screen.getByRole("button", { name: "Manage" }));
  return user;
}

beforeEach(() => startInstall.mockReset());

describe("SlackRow", () => {
  it("says which workspace, which agent answers and who installed it", () => {
    render(<SlackRow installation={installation([])} agents={AGENTS} installedBy="Deniz" />);
    expect(
      screen.getByText("Acme · Support answers mentions and messages · installed by Deniz"),
    ).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("asks for a reconnect when the install cannot hear channel activity", async () => {
    const user = await manage(["channels:history"]);
    expect(
      screen.getByText(/can't start on channel messages or reactions yet/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(startInstall).toHaveBeenCalledOnce();
  });

  it("says nothing about it for an install that has every scope", async () => {
    await manage([]);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("says nothing about it to an API that does not report scopes", async () => {
    await manage(undefined);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });
});

describe("SlackCard", () => {
  it("offers the install where the deployment has a Slack app", async () => {
    const user = userEvent.setup();
    render(<SlackCard state={{ configured: true, installation: null } satisfies SlackState} />);
    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    expect(startInstall).toHaveBeenCalledOnce();
  });

  it("names the variables that would turn it on", () => {
    render(<SlackCard state={{ configured: false, installation: null }} />);
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/SLACK_CLIENT_ID/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
