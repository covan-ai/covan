import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/lib/api-client", () => ({ assetSrc: (path: string) => path }));

const { NeedsBlock } = await import("./needs-block");

const base = {
  agentName: "Inbox",
  onConnect: () => {},
  connecting: false,
  onAllow: () => {},
};

describe("NeedsBlock", () => {
  it("offers one Connect per app of a group that is not connected", async () => {
    const onConnect = vi.fn();
    render(
      <NeedsBlock
        {...base}
        onConnect={onConnect}
        groups={[
          {
            key: "gmail|outlook",
            name: "Gmail or Outlook",
            toolkits: ["gmail", "outlook"],
            connected: false,
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(onConnect).toHaveBeenCalledWith("outlook");
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
  });

  it("offers the switch for a connected app it changes things in, and reports a change", async () => {
    const onAllow = vi.fn();
    render(
      <NeedsBlock
        {...base}
        onAllow={onAllow}
        groups={[
          {
            key: "gmail",
            name: "Gmail",
            toolkits: ["gmail"],
            connected: true,
            change: { connectionId: "conn-1", on: true },
          },
        ]}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Let Inbox change things in Gmail without asking",
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onAllow).toHaveBeenCalledWith("conn-1", false);
  });

  it("says who may allow it when this person may not", () => {
    render(
      <NeedsBlock
        {...base}
        groups={[
          {
            key: "gmail",
            name: "Gmail",
            toolkits: ["gmail"],
            connected: true,
            change: { connectionId: null, on: false },
          },
        ]}
      />,
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.getByText("Only the person who connected Gmail, or an admin, can allow this."),
    ).toBeInTheDocument();
  });
});
