import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";

const { onAuthStateChange, readSession } = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  readSession: vi.fn(),
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
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

    expect(await screen.findByText("Choose a new password")).toBeInTheDocument();
  });

  // A reset link proves the mailbox, not the authenticator: GoTrue will not
  // change the password of an account with one until its code is given.
  it("asks for the code first when the account has an authenticator", async () => {
    readSession.mockResolvedValue({ kind: "second-factor", session: {} });
    await renderReset();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/two-factor",
        search: { next: "/reset-password" },
        replace: true,
      }),
    );
  });

  it("says the link expired when there is genuinely no session", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    await renderReset();

    expect(await screen.findByText("This link no longer works")).toBeInTheDocument();
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
      await screen.findByText("Choose a new password", undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("This link no longer works")).not.toBeInTheDocument();
  }, 10000);
});
