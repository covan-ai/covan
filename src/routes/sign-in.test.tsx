import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { SessionAnswer } from "@/lib/supabase/session";

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

const readSession = vi.fn<() => Promise<SessionAnswer>>(async () => ({ kind: "none" }));
vi.mock("@/lib/supabase/session", () => ({ readSession }));

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

describe("the sign-in page when somebody is already signed in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSession.mockResolvedValue({ kind: "none" });
  });

  // The whole of the "it signs me out when I go to the home page" report. The
  // session was never lost: `/` is a landing page that does not look for one,
  // so its only button sends a signed-in person here — and this page used to
  // answer a password prompt, which is indistinguishable from having been
  // signed out. Nothing was wrong with the session; both doors were just blind.
  it("lets a held session straight through to the app", async () => {
    readSession.mockResolvedValue({
      kind: "session",
      session: { access_token: "t" } as never,
    });

    await renderSignIn();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("asks for a password when nobody is signed in", async () => {
    await renderSignIn();

    await waitFor(() => expect(readSession).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  // The third answer means the lookup could not complete, not that the session
  // is gone. Forwarding on it would strand somebody on a Loading… screen behind
  // a network they cannot reach; the form is the useful thing to show instead.
  it("still offers the form when the lookup could not complete", async () => {
    readSession.mockResolvedValue({ kind: "unknown" });

    await renderSignIn();

    await waitFor(() => expect(readSession).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });
});

describe("the sign-in page's Remember me box", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSession.mockResolvedValue({ kind: "none" });
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
