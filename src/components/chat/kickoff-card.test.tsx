import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const composio = vi.fn();
const source = vi.fn();
vi.mock("@/hooks/use-connections", () => ({
  useConnectComposio: () => ({ mutate: composio, isPending: false }),
  useStartConnection: () => ({ mutate: source, isPending: false }),
}));
vi.mock("@/lib/api-client", () => ({
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { KickoffCard } from "./kickoff-card";
import { toolById } from "@/lib/onboarding-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KickoffCard", () => {
  it("connects a Composio tool from the card", async () => {
    render(<KickoffCard tool={toolById("gmail")!} bundleId={null} onDismiss={vi.fn()} />);

    expect(screen.getByText("Connect Gmail")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(composio).toHaveBeenCalledWith({ toolkit: "gmail" }, expect.anything());
  });

  it("starts a source into the agent's bundle, or sends to Integrations without one", async () => {
    const { rerender } = render(
      <KickoffCard tool={toolById("notion")!} bundleId="b1" onDismiss={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(source).toHaveBeenCalledWith({ provider: "notion", bundleId: "b1" }, expect.anything());

    rerender(<KickoffCard tool={toolById("notion")!} bundleId={null} onDismiss={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/integrations");
  });

  it("can be put down", async () => {
    const onDismiss = vi.fn();
    render(<KickoffCard tool={toolById("slack")!} bundleId={null} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
