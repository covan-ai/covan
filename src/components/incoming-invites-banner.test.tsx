import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IncomingInvitesBanner } from "./incoming-invites-banner";
import { InviteAcceptStep } from "./welcome/invite-accept-step";
import { WORKSPACE_SCOPED_QUERY_KEYS } from "@/lib/workspace-queries";
import { stashInvite } from "@/lib/invite-stash";

const incoming = vi.fn(async () => [
  { id: "inv-1", workspaceName: "Efe's Workspace", role: "member" },
]);
const accept = vi.fn(async (_id: string, _token: string) => ({ workspaceId: "ws-1" }));

// Mocked wholesale rather than through importActual: the real module builds a
// Supabase client at import time, which needs env this process does not have.
vi.mock("@/lib/api-client", () => ({
  api: {
    invitations: {
      incoming: () => incoming(),
      accept: (id: string, token: string) => accept(id, token),
    },
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * A client holding an answer for every workspace-scoped query, as the invitee's
 * app does: they signed up, got a workspace of their own, and everything was
 * fetched against it before the invitation was ever accepted.
 */
function seededClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const key of WORKSPACE_SCOPED_QUERY_KEYS) {
    queryClient.setQueryData([key], []);
  }
  return queryClient;
}

function invalidatedKeys(queryClient: QueryClient): string[] {
  return WORKSPACE_SCOPED_QUERY_KEYS.filter(
    (key) => queryClient.getQueryState([key])?.isInvalidated,
  );
}

beforeEach(() => {
  incoming.mockClear();
  accept.mockClear();
  localStorage.clear();
});

// Accepting an invitation swaps the workspace the whole app is looking at, and
// nothing in these query keys names a workspace — so every cached answer belongs
// to the workspace the invitee is leaving behind. Both accept buttons used to
// invalidate a hand-written list that had drifted from the real one: `bundles`
// was missing from both, so the knowledge bundles of the workspace they had just
// joined were replaced by the empty list from the workspace they left, and the
// agents (which were on the list) arrived without them.
describe.each([
  ["the banner", () => <IncomingInvitesBanner />, /accept/i],
  ["the welcome step", () => <InviteAcceptStep onJoined={vi.fn()} onSkip={vi.fn()} />, /join/i],
])("accepting an invitation from %s", (_name, renderComponent, buttonName) => {
  it("refetches everything that belongs to a workspace", async () => {
    const queryClient = seededClient();
    const user = userEvent.setup();

    // What `/invite` leaves behind when the email's link was opened here.
    stashInvite("inv-1", "tok-1");
    render(<QueryClientProvider client={queryClient}>{renderComponent()}</QueryClientProvider>);

    await user.click(await screen.findByRole("button", { name: buttonName }));

    await waitFor(() => expect(accept).toHaveBeenCalledWith("inv-1", "tok-1"));
    await waitFor(() =>
      expect(invalidatedKeys(queryClient)).toEqual([...WORKSPACE_SCOPED_QUERY_KEYS]),
    );
  });

  // Accepting takes the token from the invitation's email (migration 0090). A
  // button without one could only ever be refused, so there is none, and the
  // invitation says where the way in is.
  it("offers no button without the token from the email, and says why", async () => {
    render(<QueryClientProvider client={seededClient()}>{renderComponent()}</QueryClientProvider>);

    expect(await screen.findByText(/open the link in your invitation email/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
    expect(accept).not.toHaveBeenCalled();
  });
});

// The invitee is not in the workspace yet, so the name and the sender are the
// only things that tell them what they are being asked to join (0114).
describe("an invitation that says who it is from", () => {
  beforeEach(() => {
    incoming.mockResolvedValueOnce([
      { id: "inv-1", workspaceName: "Acme", inviterName: "Ada", role: "member" } as never,
    ]);
  });

  it("names the sender in the banner", async () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <IncomingInvitesBanner />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/ada invited you to/i)).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("names the sender in the welcome step", async () => {
    render(
      <QueryClientProvider client={seededClient()}>
        <InviteAcceptStep onJoined={vi.fn()} onSkip={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/from ada/i)).toBeInTheDocument();
  });
});

describe("the invitation in the welcome step", () => {
  // Declining lives on the screen's bar now, not in the step. What the step
  // keeps is the way through when the invitation was taken elsewhere.
  it("continues through the skip when the invitation is gone, and does not count as joining", async () => {
    incoming.mockResolvedValueOnce([]);
    const onJoined = vi.fn();
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={seededClient()}>
        <InviteAcceptStep onJoined={onJoined} onSkip={onSkip} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /continue/i }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("offers Join for a waiting invitation", async () => {
    incoming.mockResolvedValueOnce([
      { id: "inv-1", workspaceName: "Acme", inviterName: "Ada", role: "member" } as never,
    ]);
    render(
      <QueryClientProvider client={seededClient()}>
        <InviteAcceptStep onJoined={vi.fn()} onSkip={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Acme")).toBeInTheDocument();
  });
});
