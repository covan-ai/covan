import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { stashedInviteLink, stashedInviteToken } from "@/lib/invite-stash";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const getSession = vi.fn();
const signOut = vi.fn(async () => ({}));
vi.mock("@/lib/supabase/client", () => ({
  supabase: { auth: { getSession: () => getSession(), signOut: () => signOut() } },
}));
vi.mock("@/lib/legal", () => ({
  termsLink: () => ({ href: "/terms", external: false }),
  privacyLink: () => ({ href: "/privacy", external: false }),
  statusLink: () => null,
}));

// Nothing on this page may accept an emailed invitation. Mocked so a call
// would be visible.
const accept = vi.fn();
const preview = vi.fn();
const linkPreview = vi.fn();
const linkAccept = vi.fn();
const complete = vi.fn(async () => ({ completed: true }));
vi.mock("@/lib/api-client", () => ({
  api: {
    invitations: { accept, preview },
    inviteLinks: { preview: linkPreview, accept: linkAccept },
    onboarding: { complete: () => complete() },
  },
  ApiError: class ApiError extends Error {},
}));

/**
 * Where an invitation email's button lands (migration 0090). The token in the
 * fragment is what accepting takes; this page keeps it and gets it out of the
 * address bar, and never accepts on its own — mail scanners open links.
 */
async function renderInvite(url: string) {
  window.history.replaceState(null, "", url);
  const { Route } = await import("./invite");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getSession.mockResolvedValue({ data: { session: null } });
  preview.mockRejectedValue(new Error("not found"));
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("the invitation landing page", () => {
  it("keeps the token in this browser and takes it out of the address bar", async () => {
    await renderInvite("/invite#id=inv-1&token=tok-abc");

    await waitFor(() => expect(stashedInviteToken("inv-1")).toBe("tok-abc"));
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("tok-abc");
  });

  it("offers sign-up and sign-in to somebody not signed in", async () => {
    await renderInvite("/invite#id=inv-1&token=tok-abc");

    expect(await screen.findByText(/you've been invited/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create an account/i })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/sign-in");
  });

  it("sends somebody signed in to the app, where Accept is a button they press", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });

    await renderInvite("/invite#id=inv-1&token=tok-abc");

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
    expect(accept).not.toHaveBeenCalled();
  });

  it("says the link is incomplete when it carries no token", async () => {
    await renderInvite("/invite");

    expect(await screen.findByText(/that link is incomplete/i)).toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
  });

  it("names the workspace, who sent it and the address to use", async () => {
    preview.mockResolvedValue({
      workspaceName: "Acme",
      inviterName: "Ada",
      email: "bob@acme.com",
      role: "member",
      open: true,
    });

    await renderInvite("/invite#id=inv-1&token=tok-abc");

    expect(await screen.findByText("Ada invited you to Acme")).toBeInTheDocument();
    expect(screen.getByText(/you can use every shared agent/i)).toBeInTheDocument();
    expect(screen.getByText("bob@acme.com")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith("inv-1", "tok-abc");
    expect(accept).not.toHaveBeenCalled();
  });

  it("says so when the invitation has expired", async () => {
    preview.mockResolvedValue({
      workspaceName: "Acme",
      inviterName: "Ada",
      email: "bob@acme.com",
      role: "member",
      open: false,
    });

    await renderInvite("/invite#id=inv-1&token=tok-abc");

    expect(await screen.findByText(/this invitation has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/ask ada to send a new one/i)).toBeInTheDocument();
  });

  it("asks nothing for somebody already signed in", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });

    await renderInvite("/invite#id=inv-1&token=tok-abc");

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps a workspace's link in this browser for somebody signed out", async () => {
    linkPreview.mockResolvedValue({
      workspaceName: "Acme",
      inviterName: "Ada",
      role: "member",
      memberCount: 6,
      agentCount: 4,
      expiresAt: Date.now() + 5 * 86_400_000,
      open: true,
    });
    await renderInvite("/invite#link=lnk-1");

    expect(await screen.findByText("Ada invited you to Acme")).toBeInTheDocument();
    expect(screen.getByText("6 members · 4 agents")).toBeInTheDocument();
    expect(screen.getByText(/expires in 5 days/)).toBeInTheDocument();
    expect(stashedInviteLink()).toBe("lnk-1");
    expect(window.location.href).not.toContain("lnk-1");
    expect(linkAccept).not.toHaveBeenCalled();
  });

  it("joins with a link only when somebody signed in presses Accept", async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "mina@acme.test", user_metadata: {} } } },
    });
    linkPreview.mockResolvedValue({
      workspaceName: "Acme",
      inviterName: "Ada",
      role: "member",
      memberCount: 6,
      agentCount: 4,
      expiresAt: Date.now() + 5 * 86_400_000,
      open: true,
    });
    linkAccept.mockResolvedValue({ workspaceId: "w1" });
    await renderInvite("/invite#link=lnk-1");

    const button = await screen.findByRole("button", { name: "Accept and join Acme" });
    expect(screen.getByText("signed in")).toBeInTheDocument();
    expect(linkAccept).not.toHaveBeenCalled();
    await userEvent.click(button);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
    expect(linkAccept).toHaveBeenCalledWith("lnk-1");
    expect(complete).toHaveBeenCalled();
    expect(stashedInviteLink()).toBeNull();
  });
});
