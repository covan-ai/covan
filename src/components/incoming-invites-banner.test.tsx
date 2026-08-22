import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IncomingInvitesBanner } from "./incoming-invites-banner";
import { InviteAcceptStep } from "./welcome/invite-accept-step";
import { WORKSPACE_SCOPED_QUERY_KEYS } from "@/lib/workspace-queries";

const incoming = vi.fn(async () => [
  { id: "inv-1", workspaceName: "Efe's Workspace", role: "member" },
]);
const accept = vi.fn(async (_id: string) => ({ workspaceId: "ws-1" }));

// Mocked wholesale rather than through importActual: the real module builds a
// Supabase client at import time, which needs env this process does not have.
vi.mock("@/lib/api-client", () => ({
  api: { invitations: { incoming: () => incoming(), accept: (id: string) => accept(id) } },
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
  ["the welcome step", () => <InviteAcceptStep onDone={vi.fn()} />, /join/i],
])("accepting an invitation from %s", (_name, renderComponent, buttonName) => {
  it("refetches everything that belongs to a workspace", async () => {
    const queryClient = seededClient();
    const user = userEvent.setup();

    render(<QueryClientProvider client={queryClient}>{renderComponent()}</QueryClientProvider>);

    await user.click(await screen.findByRole("button", { name: buttonName }));

    await waitFor(() => expect(accept).toHaveBeenCalledWith("inv-1"));
    await waitFor(() =>
      expect(invalidatedKeys(queryClient)).toEqual([...WORKSPACE_SCOPED_QUERY_KEYS]),
    );
  });
});
