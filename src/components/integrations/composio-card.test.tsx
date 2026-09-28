import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";
import { ComposioCard } from "./composio-card";

/**
 * What this workspace has connected, and what may be done about it.
 *
 * The catalogue itself moved out to `app-catalogue.test.tsx` when it stopped
 * being a text field inside this card, and it is stubbed here: a test that
 * renders both is a test that fails for two reasons. What is left is the part
 * that was always this card's — a deployment without the key says which
 * variable would turn the feature on rather than hiding it, a viewer is shown
 * what exists without being offered a control that would answer 403, and a
 * standing permission is listed with a way to take it back.
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

/** What the card is handed, so a test can assert on the dedupe it computes. */
let offeredTo: Set<string> | null = null;

// Mocked whole rather than partially, for the reason connection-card.test.tsx
// gives: the real module constructs a Supabase client at import time, which
// needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn() },
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
  ApiError: class ApiError extends Error {},
}));

// Stubbed rather than rendered: it has its own file, and it would otherwise
// pull three more hooks into every test here.
vi.mock("@/components/integrations/app-catalogue", () => ({
  AppCatalogue: ({ connected }: { connected: Set<string> }) => {
    offeredTo = connected;
    return <div data-testid="catalogue" />;
  },
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
  useComposioToolkits: () => ({
    data: { pages: [{ configured, toolkits: [], nextCursor: "" }] },
    isPending: false,
  }),
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
    toolkitSlug: "gmail",
    status: "active",
    logoPath: "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    createdAt: 1,
    ...over,
  };
}

beforeEach(() => {
  configured = true;
  role = "admin";
  grants = [];
  offeredTo = null;
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
    expect(screen.queryByTestId("catalogue")).not.toBeInTheDocument();
  });

  it("tells the catalogue what is already connected, so it is not offered twice", async () => {
    // Offering Gmail again would fail on the unique label, with a message
    // about a name rather than about what happened.
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    expect(screen.getByTestId("catalogue")).toBeInTheDocument();
    expect([...(offeredTo ?? [])]).toEqual(["gmail"]);
  });

  it("shows the application's own mark, fetched through this API and not Composio", async () => {
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    const logo = screen.getByRole("presentation", { hidden: true });
    expect(logo).toHaveAttribute(
      "src",
      "https://api.test/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
    expect(logo).toHaveAttribute("loading", "lazy");
  });

  it("says a half-finished connection is not finished", async () => {
    render(<ComposioCard connections={[app({ status: "pending" })]} agents={AGENTS} />);
    expect(screen.getByText("Finishing…")).toBeInTheDocument();
  });

  it("shows a viewer what is connected without offering a control that would 403", async () => {
    role = "viewer";
    render(<ComposioCard connections={[app()]} agents={AGENTS} />);
    expect(screen.getByText("Ana's Gmail")).toBeInTheDocument();
    expect(screen.queryByTestId("catalogue")).not.toBeInTheDocument();
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
