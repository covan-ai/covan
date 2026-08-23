import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const signInWithPassword = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signInWithPassword } } }));

const setRemember = vi.fn();
vi.mock("@/lib/supabase/auth-storage", () => ({ setRemember }));

async function renderSignIn() {
  const { Route } = await import("./sign-in");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/work email/i), "you@company.com");
  await user.type(screen.getByLabelText(/^password$/i), "hunter2hunter2");
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("the sign-in page's Remember me box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts checked", async () => {
    await renderSignIn();

    expect(screen.getByRole("checkbox", { name: /remember me/i })).toBeChecked();
  });

  // The box used to be decorative: no name, never read by the submit handler,
  // never passed to supabase. Checking or clearing it changed nothing at all.
  it("records the answer before the session exists to be stored", async () => {
    const user = userEvent.setup();
    await renderSignIn();

    await fillAndSubmit(user);

    expect(setRemember).toHaveBeenCalledWith(true);
    expect(setRemember.mock.invocationCallOrder[0]).toBeLessThan(
      signInWithPassword.mock.invocationCallOrder[0],
    );
  });

  it("carries a cleared box through to the storage choice", async () => {
    const user = userEvent.setup();
    await renderSignIn();

    await user.click(screen.getByRole("checkbox", { name: /remember me/i }));
    await fillAndSubmit(user);

    expect(setRemember).toHaveBeenCalledWith(false);
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "you@company.com",
      password: "hunter2hunter2",
    });
  });
});
