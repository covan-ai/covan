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

type SignUpResult = { data: { session: { user: { id: string } } | null }; error: null };
const signUp = vi.fn(async (): Promise<SignUpResult> => ({ data: { session: null }, error: null }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signUp } } }));

vi.mock("@/lib/legal", () => ({
  termsLink: () => ({ href: "/terms", external: false }),
  privacyLink: () => ({ href: "/privacy", external: false }),
}));

async function renderSignUp() {
  const { Route } = await import("./sign-up");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, email = "you@company.com") {
  await user.type(screen.getByLabelText(/full name/i), "Alex Rivera");
  await user.type(screen.getByLabelText(/work email/i), email);
  await user.type(screen.getByLabelText(/^password$/i), "hunter2hunter2");
  await user.type(screen.getByLabelText(/confirm password/i), "hunter2hunter2");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

describe("signing up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signUp.mockResolvedValue({ data: { session: null }, error: null });
  });

  // Left unset, GoTrue sends the confirmation link to the project's Site URL —
  // `/`, which is a marketing page on the hosted build. Confirming worked and
  // said nothing, which is how it was reported: "no feedback on whether it was
  // confirmed".
  it("asks for the confirmation link to come back to a page that reports on it", async () => {
    const user = userEvent.setup();
    await renderSignUp();

    await fillAndSubmit(user);

    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          emailRedirectTo: `${window.location.origin}/confirmed`,
        }),
      }),
    );
  });

  it("names the inbox it just sent to", async () => {
    const user = userEvent.setup();
    await renderSignUp();

    await fillAndSubmit(user, "someone@example.com");

    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText("someone@example.com")).toBeInTheDocument();
  });

  it("goes straight in when the deployment confirms nothing", async () => {
    signUp.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    const user = userEvent.setup();
    await renderSignUp();

    await fillAndSubmit(user);

    expect(navigate).toHaveBeenCalledWith({ to: "/app" });
  });
});
