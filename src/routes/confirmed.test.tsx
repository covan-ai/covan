import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const getSession = vi.fn();
const onAuthStateChange = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  supabase: { auth: { getSession: () => getSession(), onAuthStateChange } },
}));

/**
 * The page a confirmation link lands on.
 *
 * Its whole job is to say which of three things happened, so the tests are one
 * per outcome. The one that matters most is the third: before this page
 * existed, every outcome looked identical, because every outcome was the site's
 * front door.
 */
async function renderConfirmed(url: string) {
  window.history.replaceState(null, "", url);
  const { Route } = await import("./confirmed");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  vi.clearAllMocks();
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  getSession.mockResolvedValue({ data: { session: null } });
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("the confirmation landing page", () => {
  it("says the address is confirmed once the link's session arrives", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });

    await renderConfirmed("/confirmed#access_token=abc&type=signup");

    expect(await screen.findByText(/address confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /continue to covan/i })).toHaveAttribute(
      "href",
      "/app",
    );
  });

  it("takes the session from the auth event when it lands after the first look", async () => {
    // supabase-js parses the fragment itself, and on a slow exchange
    // getSession() answers "none" before it has finished. Without the
    // subscription the page would settle on the neutral state and tell somebody
    // whose account was just confirmed to go and confirm it.
    await renderConfirmed("/confirmed#access_token=abc&type=signup");

    const [handler] = onAuthStateChange.mock.calls[0];
    handler("SIGNED_IN", { user: { id: "u1" } });

    expect(await screen.findByText(/address confirmed/i)).toBeInTheDocument();
  });

  it("reads an expired link out of the URL and offers the two ways forward", async () => {
    await renderConfirmed(
      "/confirmed#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(screen.getByText(/that link didn't work/i)).toBeInTheDocument();
    // Decoded, including the `+` that a URL-encoded sentence uses for a space.
    expect(screen.getByText("Email link is invalid or has expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /send a new link/i })).toBeInTheDocument();

    // Nothing to wait for: the answer was in the URL before React rendered.
    expect(onAuthStateChange).not.toHaveBeenCalled();
  });

  it("claims nothing when it was opened without a link behind it", async () => {
    await renderConfirmed("/confirmed");

    // The tempting shortcut is to treat "no error" as "confirmed". It is a
    // guess, and it would be presented as a fact about somebody's account.
    await waitFor(() => expect(screen.getByText(/confirm your address/i)).toBeInTheDocument());
    expect(screen.queryByText(/address confirmed/i)).not.toBeInTheDocument();
  });
});
