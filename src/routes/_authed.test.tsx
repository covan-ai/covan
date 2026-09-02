import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type React from "react";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: "/app" } }),
  Outlet: () => <div>the app</div>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ enabled }: { enabled?: boolean }) => ({
    data: enabled ? { onboarding: { completed: true } } : undefined,
    isError: false,
    isPending: !enabled,
  }),
}));

vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn() } }));

type AuthListener = (event: string, session: unknown) => void;

const onAuthStateChange = vi.fn((_listener: AuthListener) => ({
  data: { subscription: { unsubscribe: vi.fn() } },
}));

/** The callback `_authed` handed to onAuthStateChange, so a test can fire it. */
const emit = (event: string, session: unknown) =>
  onAuthStateChange.mock.calls[0][0](event, session);
vi.mock("@/lib/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange } },
}));

const readSession = vi.fn();
vi.mock("@/lib/supabase/session", () => ({ readSession }));

async function renderAuthed() {
  const { Route } = await import("./_authed");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the gate in front of every signed-in page", () => {
  it("shows the page when there is a session", async () => {
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "a" } });

    await renderAuthed();

    expect(await screen.findByText("the app")).toBeInTheDocument();
  });

  it("sends you to sign in when there is genuinely nobody signed in", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    await renderAuthed();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sign-in" }));
  });

  /**
   * The bug this file exists for. A refresh that fails for a retryable reason
   * leaves a perfectly good session in localStorage and still answers
   * `session: null`. Redirecting on that is what threw people out between
   * visits and asked them for their password again.
   */
  it("does not sign you out when the lookup could not complete", async () => {
    readSession.mockResolvedValue({ kind: "unknown" });

    await renderAuthed();

    await screen.findByText(/can.t reach covan/i);
    expect(navigate).not.toHaveBeenCalledWith({ to: "/sign-in" });
  });

  // Real time rather than fake: the retry is a setTimeout the component owns,
  // and the assertion worth making is that it fires without anybody clicking.
  it("asks again after a lookup that could not complete", async () => {
    readSession.mockResolvedValueOnce({ kind: "unknown" });
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "a" } });

    await renderAuthed();

    expect(await screen.findByText("the app", undefined, { timeout: 6000 })).toBeInTheDocument();
  }, 10000);

  /**
   * `onAuthStateChange` fires INITIAL_SESSION with null on the same failed
   * lookup, so a listener that redirects on any null session undoes the fix
   * above from the other side.
   */
  it("ignores the initial null the failed lookup also emits", async () => {
    readSession.mockResolvedValue({ kind: "unknown" });

    await renderAuthed();
    await screen.findByText(/can.t reach covan/i);

    emit("INITIAL_SESSION", null);

    expect(navigate).not.toHaveBeenCalledWith({ to: "/sign-in" });
  });

  it("still sends you to sign in when you actually sign out", async () => {
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "a" } });

    await renderAuthed();
    await screen.findByText("the app");

    emit("SIGNED_OUT", null);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sign-in" }));
  });
});
