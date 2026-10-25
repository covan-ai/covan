import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";
import { ConnectedApps } from "./composio-card";

/**
 * What this workspace has connected, and what may be done about it: a row
 * each in Connected (A8), and Manage for the rest. A viewer is shown what
 * exists without being offered a control that would answer 403, and a
 * standing permission is listed with a way to take it back. The catalogue
 * and its unconfigured state are `app-catalogue.test.tsx`'s.
 */
const { connect, removeConnection, revokeGrant, updateConnection } = vi.hoisted(() => ({
  connect: { mutate: vi.fn(), isPending: false },
  removeConnection: { mutate: vi.fn(), isPending: false },
  revokeGrant: { mutate: vi.fn(), isPending: false },
  updateConnection: { mutate: vi.fn(), isPending: false },
}));

const AGENTS = [{ id: "agent-1", name: "Sales" }];
let grants: ToolConnectionGrant[] = [];

let role = "admin";

// Mocked whole rather than partially, for the reason connection-card.test.tsx
// gives: the real module constructs a Supabase client at import time, which
// needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn() },
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
      data:
        queryKey[0] === "me"
          ? { user: { id: "user-1" }, members: [{ id: "user-1", role }] }
          : undefined,
    }),
  };
});

vi.mock("@/hooks/use-connections", () => ({
  useComposioGrants: () => ({ data: { grants } }),
  useRemoveComposioGrant: () => revokeGrant,
  useConnectComposio: () => connect,
  useComposioStatus: () => ({ data: undefined }),
  useRemoveToolConnection: () => removeConnection,
  useUpdateToolConnection: () => updateConnection,
}));

function app(over: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "conn-1",
    label: "Ana's Gmail",
    transport: "composio",
    baseUrl: "https://backend.composio.dev",
    allowedMethods: ["GET"],
    summary: null,
    rpc: null,
    toolkitSlug: "gmail",
    status: "active",
    logoPath: "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    scope: "owner",
    mine: true,
    unavailable: null,
    createdAt: 1,
    ...over,
  };
}

beforeEach(() => {
  role = "admin";
  grants = [];
  connect.mutate.mockClear();
  removeConnection.mutate.mockClear();
  revokeGrant.mutate.mockClear();
});

function renderApps(connections: ToolConnection[]) {
  return render(
    <ul>
      <ConnectedApps connections={connections} agents={AGENTS} />
    </ul>,
  );
}

async function manage(connections: ToolConnection[]) {
  renderApps(connections);
  await userEvent.click(screen.getByRole("button", { name: "Manage" }));
  return within(screen.getByRole("dialog"));
}

const STANDING: ToolConnectionGrant = {
  agentId: "agent-1",
  connectionId: "conn-1",
  slug: "GMAIL_SEND_EMAIL",
  mode: "always",
  grantedBy: "user-1",
  grantedAt: 1,
};

describe("ConnectedApps", () => {
  // 0139: a person's own mailbox or calendar leads to what arrives there.
  it("links a mailbox of the person's own to what arrives there", () => {
    renderApps([app({})]);
    expect(screen.getByRole("link", { name: "What arrives here" }).getAttribute("href")).toBe(
      "/arrivals",
    );
  });

  it.each([
    ["an application a scan does not read", { toolkitSlug: "linear" }],
    ["a mailbox still being connected", { status: "pending" as const }],
    ["somebody else's mailbox", { mine: false }],
  ])("does not link %s", (_what, over) => {
    renderApps([app(over)]);
    expect(screen.queryByRole("link", { name: "What arrives here" })).toBeNull();
  });

  it("lists only the connected apps, whose they are and how they are doing", () => {
    renderApps([app(), app({ id: "svc", transport: "http", label: "Orders API" })]);
    expect(screen.getByText("Ana's Gmail")).toBeInTheDocument();
    expect(screen.getByText("gmail · only you")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("Orders API")).not.toBeInTheDocument();
  });

  it("shows the application's own mark, fetched through this API and not Composio", () => {
    renderApps([app()]);
    const logo = screen.getByRole("presentation", { hidden: true });
    expect(logo).toHaveAttribute(
      "src",
      "https://api.test/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
    expect(logo).toHaveAttribute("loading", "lazy");
  });

  it("says a half-finished connection is not finished", () => {
    renderApps([app({ status: "pending", createdAt: Date.now() })]);
    expect(screen.getByText("Finishing…")).toBeInTheDocument();
  });

  // covan#258: Composio said active on a key the provider refuses. Said on
  // the row, and in the provider's words under Manage.
  it("says a refused key was refused, in the provider's words, and what to do", async () => {
    const dialog = await manage([
      app({
        status: "active",
        verifyError: "PostHog refused this credential: Personal API key is invalid.",
      }),
    ]);
    expect(screen.getByText("Key refused")).toBeInTheDocument();
    expect(
      dialog.getByText(/Personal API key is invalid\. Remove it and connect again/),
    ).toBeInTheDocument();
  });

  it("stops saying Finishing about a sign-in abandoned long ago, and says what to do", async () => {
    const dialog = await manage([app({ status: "pending", createdAt: Date.now() - 60 * 60_000 })]);
    expect(screen.queryByText("Finishing…")).not.toBeInTheDocument();
    expect(screen.getByText("Not finished")).toBeInTheDocument();
    expect(dialog.getByText(/was not finished, so agents cannot use it/)).toBeInTheDocument();
  });

  /**
   * covan#276. An app whose only useful operation the service refused is
   * hidden from agents for thirty days, and the card used to say "connected"
   * and nothing else for all of them.
   */
  it("says how many operations are hidden, why, and when they are tried again", async () => {
    const until = Date.parse("2026-11-07T22:51:56Z");
    const dialog = await manage([app({ unavailable: { count: 1, hiddenUntil: until } })]);
    expect(screen.getByText(/1 operation hidden/)).toBeInTheDocument();
    expect(dialog.getByText(/refused an operation when an agent tried it/)).toHaveTextContent(
      `Tried again from ${new Date(until).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}.`,
    );
  });

  it("says nothing about hidden operations when there are none", async () => {
    const dialog = await manage([app()]);
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/refused/)).not.toBeInTheDocument();
  });

  it("shows a viewer what is connected without offering a control that would 403", async () => {
    role = "viewer";
    const dialog = await manage([app()]);
    expect(dialog.getByRole("heading", { name: "Ana's Gmail" })).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("confirms in place before revoking", async () => {
    const dialog = await manage([app()]);
    await userEvent.click(dialog.getByRole("button", { name: /remove ana's gmail/i }));
    // Nothing has happened yet — the first press asks. Removing revokes the
    // grant at Composio before the row goes.
    expect(removeConnection.mutate).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole("button", { name: "Remove" }));
    expect(removeConnection.mutate).toHaveBeenCalledWith("conn-1", expect.anything());
  });

  /**
   * A standing permission somebody can give in a chat and never find again is
   * the failure this block exists against. It is the only kind of permission
   * here that is a ROW — everything else asks, and the absence of a row is
   * what the asking is — so it is the only kind that has to be listed.
   */
  it("names each standing permission and whose it is", async () => {
    grants = [STANDING];
    const dialog = await manage([app()]);
    expect(screen.getByText(/1 operation runs without asking/)).toBeInTheDocument();
    expect(dialog.getByText("GMAIL_SEND_EMAIL")).toBeInTheDocument();
    expect(dialog.getByText(/Sales runs this without asking/)).toBeInTheDocument();
  });

  it("does not list an ask grant, because asking is what no row already means", async () => {
    grants = [{ ...STANDING, slug: "GMAIL_FETCH_EMAILS", mode: "ask" }];
    const dialog = await manage([app()]);
    expect(dialog.queryByText("GMAIL_FETCH_EMAILS")).not.toBeInTheDocument();
  });

  it("takes a standing permission back in one press, with nothing to confirm", async () => {
    // Removing a permission cannot be the unsafe direction, and asking "are
    // you sure?" before making something safer teaches people to click
    // through the question that matters.
    grants = [STANDING];
    const dialog = await manage([app()]);
    await userEvent.click(dialog.getByRole("button", { name: "Ask first" }));
    expect(revokeGrant.mutate).toHaveBeenCalledWith(
      { agentId: "agent-1", connectionId: "conn-1", slug: "GMAIL_SEND_EMAIL" },
      expect.anything(),
    );
  });

  // 0098: personal unless shared, and only the person who connected it can
  // share it or take it back.
  it("says whose a connected app is, and offers sharing only to whoever connected it", async () => {
    const dialog = await manage([app({ scope: "owner", mine: true })]);
    expect(dialog.getByText("Only you")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Share" }));
    expect(updateConnection.mutate).toHaveBeenCalledWith(
      { id: expect.any(String), patch: { shared: true } },
      expect.anything(),
    );
  });

  it("shows a colleague's shared app as shared, with no switch", async () => {
    const dialog = await manage([app({ scope: "workspace", mine: false })]);
    expect(dialog.getByText("Shared")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /^share/i })).toBeNull();
  });
});
