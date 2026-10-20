import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { OAuthProvider } from "@/lib/supabase/providers";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

const signInWithOAuth = vi.fn(async () => ({
  data: {},
  error: null as { message: string } | null,
}));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signInWithOAuth } } }));

const setRemember = vi.fn();
vi.mock("@/lib/supabase/auth-storage", () => ({ setRemember }));

const enabledProviders = vi.fn<() => Promise<OAuthProvider[]>>(async () => []);
vi.mock("@/lib/supabase/providers", () => ({ enabledProviders }));

async function renderButtons(remember = true) {
  const { OAuthButtons } = await import("./oauth-buttons");
  const onError = vi.fn();
  const view = render(<OAuthButtons remember={remember} onError={onError} />);
  return { ...view, onError };
}

describe("the Google and GitHub buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabledProviders.mockResolvedValue([]);
  });

  it("are absent from an install with neither provider on", async () => {
    const { container } = await renderButtons();
    await waitFor(() => expect(enabledProviders).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("offer only the providers that are on", async () => {
    enabledProviders.mockResolvedValue(["github"]);
    await renderButtons();

    expect(await screen.findByRole("button", { name: /continue with github/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /continue with google/i })).toBeNull();
  });

  // The session is written the moment the browser comes back, before any route
  // mounts, so the store has to be chosen before leaving.
  it("settles Remember me before leaving, and comes back to the callback page", async () => {
    enabledProviders.mockResolvedValue(["google", "github"]);
    const user = userEvent.setup();
    await renderButtons(false);

    await user.click(await screen.findByRole("button", { name: /continue with google/i }));

    expect(setRemember).toHaveBeenCalledWith(false);
    expect(setRemember.mock.invocationCallOrder[0]).toBeLessThan(
      signInWithOAuth.mock.invocationCallOrder[0],
    );
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  });

  // A provider's first click creates the account, on the sign-in page too.
  it("say what continuing agrees to", async () => {
    enabledProviders.mockResolvedValue(["google", "github"]);
    await renderButtons();

    expect(await screen.findByText(/continuing with google or github agrees to/i)).toBeVisible();
    expect(screen.getByText("Terms")).toBeVisible();
    expect(screen.getByText("Privacy Policy")).toBeVisible();
  });

  it("hand back an error raised before leaving", async () => {
    enabledProviders.mockResolvedValue(["github"]);
    signInWithOAuth.mockResolvedValueOnce({ data: {}, error: { message: "nope" } });
    const user = userEvent.setup();
    const { onError } = await renderButtons();

    const button = await screen.findByRole("button", { name: /continue with github/i });
    await user.click(button);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("nope"));
    expect(button).toBeEnabled();
  });
});
