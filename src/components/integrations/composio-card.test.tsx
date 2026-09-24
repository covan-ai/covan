import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";
import { ComposioCard } from "./composio-card";

/**
 * The catalogue, as a person walks it: search, click, sign in elsewhere.
 *
 * Three claims are worth keeping. A deployment without the key says which
 * variable would turn the feature on rather than hiding it, which is the rule
 * every provider card on this page follows. An application already connected is
 * not offered again, because picking it would fail on a name rather than on
 * what happened. And a viewer is shown what exists without being offered a
 * control that would answer 403.
 */
const { connect, removeConnection, revokeGrant } = vi.hoisted(() => ({
  connect: { mutate: vi.fn(), isPending: false },
  removeConnection: { mutate: vi.fn(), isPending: false },
  revokeGrant: { mutate: vi.fn(), isPending: false },
}));

const AGENTS = [{ id: "agent-1", name: "Sales" }];
let grants: ToolConnectionGrant[] = [];

let configured = true;
let role = "admin";
const DEFAULT_TOOLKITS = [
  { slug: "gmail", name: "Gmail", description: "Mail", authSchemes: ["OAUTH2"], managedAuth: true },
  {
    slug: "linear",
    name: "Linear",
    description: "Issues",
    authSchemes: ["OAUTH2"],
    managedAuth: true,
  },
];
let toolkits = DEFAULT_TOOLKITS;

// Mocked whole rather than partially, for the reason connection-card.test.tsx
// gives: the real module constructs a Supabase client at import time, which
// needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
  useComposioToolkits: () => ({ data: { configured, toolkits }, isLoading: false }),
  useConnectComposio: () => connect,
  useComposioStatus: () => ({ data: undefined }),
  useRemoveToolConnection: () => removeConnection,
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
    accountId: null,
    projectRef: null,
    toolkitSlug: "gmail",
    status: "active",
    createdAt: 1,
    ...over,
  };
}

beforeEach(() => {
  configured = true;
  role = "admin";
  grants = [];
  toolkits = DEFAULT_TOOLKITS;
  connect.mutate.mockClear();
  removeConnection.mutate.mockClear();
  revokeGrant.mutate.mockClear();
});

describe("ComposioCard", () => {
  it("names the variable rather than hiding the feature", async () => {
    configured = false;
    render(<ComposioCard connections={[]} agents={AGENTS} />);
    expect(screen.getByText(/COMPOSIO_API_KEY/)).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect an app/i })).not.toBeInTheDocument();
  });

  it("offers only applications this workspace has not connected", async () => {
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    await userEvent.click(screen.getByRole("button", { name: /connect an app/i }));

    // Gmail is already connected — offering it again would fail on the unique
    // label with a message about a name rather than about what happened.
    expect(screen.getByRole("button", { name: /Linear/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Gmail/ })).not.toBeInTheDocument();
  });

  it("hands the toolkit slug to the consent flow", async () => {
    render(<ComposioCard connections={[]} agents={AGENTS} />);
    await userEvent.click(screen.getByRole("button", { name: /connect an app/i }));
    await userEvent.click(screen.getByRole("button", { name: /Linear/ }));

    expect(connect.mutate).toHaveBeenCalledWith(
      { toolkit: "linear", label: "Linear" },
      expect.anything(),
    );
  });

  it("will not offer an app Composio has no sign-in for", async () => {
    // Registering an OAuth client with that provider is a job somebody does in
    // Composio's dashboard. A Connect button here would only produce a 400
    // from a third party and leave nothing to act on.
    toolkits = [
      {
        slug: "obscure",
        name: "Obscure",
        description: "",
        authSchemes: ["OAUTH2"],
        managedAuth: false,
      },
    ];
    render(<ComposioCard connections={[]} agents={AGENTS} />);
    await userEvent.click(screen.getByRole("button", { name: /connect an app/i }));

    const row = screen.getByRole("button", { name: /Obscure/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("Needs setup in Composio");

    await userEvent.click(row);
    expect(connect.mutate).not.toHaveBeenCalled();
  });

  it("says a half-finished connection is not finished", async () => {
    render(<ComposioCard connections={[app({ status: "pending" })]} agents={AGENTS} />);
    expect(screen.getByText("Finishing…")).toBeInTheDocument();
  });

  it("shows a viewer what is connected without offering a control that would 403", async () => {
    role = "viewer";
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    expect(screen.getByText("Ana's Gmail")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect an app/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("confirms in place before revoking", async () => {
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    // Nothing has happened yet — the first press asks. Removing revokes the
    // grant at Composio before the row goes, which is why it is not a bare
    // delete anywhere in the product.
    expect(removeConnection.mutate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeConnection.mutate).toHaveBeenCalledWith("conn-1", expect.anything());
  });

  /**
   * A standing permission somebody can give in a chat and never find again is
   * the failure this block exists against. It is the only kind of permission
   * here that is a ROW — everything else asks, and the absence of a row is
   * what the asking is — so it is the only kind that has to be listed.
   */
  it("names each standing permission and whose it is", async () => {
    grants = [
      {
        agentId: "agent-1",
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        mode: "always",
        grantedBy: "user-1",
        grantedAt: 1,
      },
    ];
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    expect(screen.getByText("GMAIL_SEND_EMAIL")).toBeInTheDocument();
    expect(screen.getByText(/Sales runs this without asking/)).toBeInTheDocument();
  });

  it("does not list an ask grant, because asking is what no row already means", async () => {
    grants = [
      {
        agentId: "agent-1",
        connectionId: "conn-1",
        slug: "GMAIL_FETCH_EMAILS",
        mode: "ask",
        grantedBy: "user-1",
        grantedAt: 1,
      },
    ];
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    expect(screen.queryByText("GMAIL_FETCH_EMAILS")).not.toBeInTheDocument();
  });

  it("takes a standing permission back in one press, with nothing to confirm", async () => {
    // No confirmation step, unlike disconnecting the app: removing a
    // permission cannot be the unsafe direction, and asking "are you sure?"
    // before making something safer teaches people to click through the
    // question that matters.
    grants = [
      {
        agentId: "agent-1",
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        mode: "always",
        grantedBy: "user-1",
        grantedAt: 1,
      },
    ];
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask first" }));
    expect(revokeGrant.mutate).toHaveBeenCalledWith(
      { agentId: "agent-1", connectionId: "conn-1", slug: "GMAIL_SEND_EMAIL" },
      expect.anything(),
    );
  });
});
