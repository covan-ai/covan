import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { SessionAnswer } from "@/lib/supabase/session";

const navigate = vi.fn();
let search: { next?: string } = {};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const signOut = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signOut } } }));

const giveSecondFactor = vi.fn(async (_code: string) => {});
vi.mock("@/lib/supabase/mfa", () => ({ giveSecondFactor }));

const readSession = vi.fn<() => Promise<SessionAnswer>>();
vi.mock("@/lib/supabase/session", () => ({ readSession }));
vi.mock("@/lib/legal", () => ({
  termsLink: () => ({ href: "/terms", external: false }),
  privacyLink: () => ({ href: "/privacy", external: false }),
  statusLink: () => null,
}));

const OWING: SessionAnswer = { kind: "second-factor", session: { access_token: "t" } as never };

async function renderPage() {
  const { Route } = await import("./two-factor");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  vi.clearAllMocks();
  search = {};
  readSession.mockResolvedValue(OWING);
});

describe("the second step of signing in", () => {
  it("takes the code and goes on to the app", async () => {
    const user = userEvent.setup();
    await renderPage();

    const input = screen.getByLabelText("Digit 1");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "123 456");
    await user.click(screen.getByRole("button", { name: /verify/i }));

    // Spaces are how people read a code aloud; GoTrue wants the digits.
    expect(giveSecondFactor).toHaveBeenCalledWith("123456");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("returns to the page that asked for it", async () => {
    search = { next: "/reset-password" };
    const user = userEvent.setup();
    await renderPage();

    const input = screen.getByLabelText("Digit 1");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: /verify/i }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/reset-password", replace: true }),
    );
  });

  it("says so when the code is wrong, and stays", async () => {
    giveSecondFactor.mockRejectedValueOnce(new Error("Invalid TOTP code entered"));
    const user = userEvent.setup();
    await renderPage();

    const input = screen.getByLabelText("Digit 1");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "000000");
    await user.click(screen.getByRole("button", { name: /verify/i }));

    expect(await screen.findByText("Invalid TOTP code entered")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("sends somebody with no session to sign in", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    await renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sign-in", replace: true }));
  });

  it("sends a session that has nothing left to give onward", async () => {
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "t" } as never });

    await renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("signs out to let somebody else in", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: /different account|not you/i }));

    expect(signOut).toHaveBeenCalled();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sign-in", replace: true }));
  });
});

describe("where the second step may send you afterwards", () => {
  it("only to a path on this site", async () => {
    const { Route } = await import("./two-factor");
    const validate = (
      Route as unknown as {
        validateSearch: (s: Record<string, unknown>) => { next?: string };
      }
    ).validateSearch;

    expect(validate({ next: "/reset-password" })).toEqual({ next: "/reset-password" });
    expect(validate({ next: "https://evil.example" })).toEqual({ next: undefined });
    expect(validate({ next: "//evil.example" })).toEqual({ next: undefined });
    expect(validate({})).toEqual({ next: undefined });
  });
});
