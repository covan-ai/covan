import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { SessionAnswer } from "@/lib/supabase/session";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const unsubscribe = vi.fn();
const onAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe } } }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { onAuthStateChange } } }));

const readSession = vi.fn<() => Promise<SessionAnswer>>(async () => ({ kind: "none" }));
vi.mock("@/lib/supabase/session", () => ({ readSession }));

async function renderCallback(url = "/auth/callback") {
  window.history.replaceState(null, "", url);
  const { Route } = await import("./auth.callback");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

describe("the page Google and GitHub send people back to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSession.mockResolvedValue({ kind: "none" });
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("takes a finished sign-in to the app", async () => {
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "t" } as never });
    await renderCallback();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  // A provider's say-so is the first step, like a password, and does not
  // excuse an account from its authenticator.
  it("takes an account with an authenticator to its code", async () => {
    readSession.mockResolvedValue({
      kind: "second-factor",
      session: { access_token: "t" } as never,
    });
    await renderCallback();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/two-factor", replace: true }),
    );
  });

  it("says why when GoTrue sent them back refused", async () => {
    await renderCallback(
      "/auth/callback?error=access_denied&error_description=Signups+not+allowed+for+this+instance",
    );

    expect(screen.getByText("Signups not allowed for this instance")).toBeVisible();
    expect(readSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says there was nothing to finish when there is no session", async () => {
    await renderCallback();

    expect(await screen.findByText(/there was nothing to finish/i)).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  });
});
