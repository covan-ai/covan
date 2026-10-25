import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnection } from "@/lib/connections-api";

/**
 * Where work arrives: Gmail, Outlook and Google Calendar, connected from the
 * page somebody is on and finished when the consent screen sends them back.
 */
const { connect, complete, pending, connections } = vi.hoisted(() => ({
  connect: { mutate: vi.fn(), isPending: false },
  complete: vi.fn(),
  pending: { value: null as unknown },
  connections: { value: [] as unknown[] },
}));

vi.mock("@/lib/api-client", () => ({
  api: { composio: { complete } },
  assetSrc: (path: string) => (path ? `https://api.test${path}` : ""),
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/sensitive-url", () => ({ takePendingGrant: () => pending.value }));
vi.mock("@/hooks/use-connections", () => ({
  toolConnectionsKey: ["tool-connections"],
  useToolConnections: () => ({ data: { connections: connections.value, tools: [] } }),
  useConnectComposio: () => connect,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ConnectCards } = await import("./connect-cards");

function own(over: Partial<ToolConnection>): ToolConnection {
  return {
    id: "c-1",
    label: "Gmail",
    transport: "composio",
    baseUrl: "",
    allowedMethods: [],
    summary: null,
    rpc: null,
    toolkitSlug: "gmail",
    status: "active",
    logoPath: "",
    scope: "owner",
    mine: true,
    ...over,
  } as ToolConnection;
}

function renderCards(onConnected = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectCards returnTo="/welcome?step=connect&agent=a1&s=s1" onConnected={onConnected} />
    </QueryClientProvider>,
  );
  return onConnected;
}

beforeEach(() => {
  connect.mutate.mockReset();
  complete.mockReset();
  pending.value = null;
  connections.value = [];
});

describe("ConnectCards", () => {
  it("offers the three places work arrives", () => {
    renderCards();
    for (const name of ["Gmail", "Outlook", "Google Calendar"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
  });

  it("starts a connection that comes back to this page", async () => {
    renderCards();
    const outlook = screen.getByText("Outlook").closest("li")!;
    await userEvent.click(within(outlook).getByRole("button", { name: "Connect" }));
    expect(connect.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ toolkit: "outlook", returnTo: "/welcome?step=connect&agent=a1&s=s1" }),
      expect.anything(),
    );
  });

  it("shows a mailbox of the person's own as connected", () => {
    connections.value = [own({})];
    renderCards();
    const gmail = screen.getByText("Gmail").closest("li")!;
    expect(within(gmail).queryByRole("button", { name: "Connect" })).toBeNull();
    // Said twice: beside the dot on a wide screen, in place of the button on a narrow one.
    expect(within(gmail).getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("does not count somebody else's connection, or one never finished", () => {
    connections.value = [own({ mine: false }), own({ id: "c-2", toolkitSlug: "outlook", status: "pending" })];
    renderCards();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
  });

  it("finishes the connection the consent screen sent back, and says which", async () => {
    pending.value = { kind: "composio", toolkit: "gmail", nonce: "n-1" };
    complete.mockResolvedValue({ status: "active" });
    const onConnected = renderCards();
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith("gmail"));
    expect(complete).toHaveBeenCalledWith("n-1");
  });

  it("does not report one that is still being finished", async () => {
    pending.value = { kind: "composio", toolkit: "gmail", nonce: "n-1" };
    complete.mockResolvedValue({ status: "pending" });
    const onConnected = renderCards();
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(onConnected).not.toHaveBeenCalled();
  });
});
