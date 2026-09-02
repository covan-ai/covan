import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";

const { onAuthStateChange, readSession } = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  readSession: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Link: ({ children, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={props.to}>{children}</a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange, updateUser: vi.fn(), signOut: vi.fn() } },
}));
vi.mock("@/lib/supabase/session", () => ({ readSession }));

async function renderReset() {
  const { Route } = await import("./reset-password");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the reset-password link check", () => {
  it("lets you set a password when the link carried a session", async () => {
    readSession.mockResolvedValue({ kind: "session", session: {} });

    await renderReset();

    expect(await screen.findByText("Set a new password")).toBeInTheDocument();
  });

  it("says the link expired when there is genuinely no session", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    await renderReset();

    expect(await screen.findByText("Link expired")).toBeInTheDocument();
  });

  /**
   * Telling somebody their reset link is dead when the check simply could not
   * reach the server sends them back to request another one — and the one in
   * their hand was fine.
   */
  it("keeps checking rather than blaming the link for a failed lookup", async () => {
    readSession.mockResolvedValueOnce({ kind: "unknown" });
    readSession.mockResolvedValue({ kind: "session", session: {} });

    await renderReset();

    expect(
      await screen.findByText("Set a new password", undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Link expired")).not.toBeInTheDocument();
  }, 10000);
});
