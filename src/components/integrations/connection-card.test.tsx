import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Connection } from "@/lib/connections-api";
import { ConnectionCard, ConnectSourceCard } from "./connection-card";

const { update, sync, disconnect, start } = vi.hoisted(() => ({
  update: { mutate: vi.fn(), isPending: false },
  sync: { mutate: vi.fn(), isPending: false },
  disconnect: { mutate: vi.fn(), isPending: false },
  start: { mutate: vi.fn(), isPending: false },
}));
// Mocked whole rather than partially: the real module constructs a Supabase
// client at import time, which needs an origin no unit test has. It arrives here
// through the folder dialog, which asks the API for one level of a Drive tree.
vi.mock("@/lib/api-client", () => ({
  api: { connections: { folders: vi.fn(async () => []) } },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-connections", () => ({
  useUpdateConnection: () => update,
  useSyncConnection: () => sync,
  useDisconnect: () => disconnect,
  useStartConnection: () => start,
}));

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    provider: "notion",
    accountLabel: "Covan HQ",
    bundleId: "bundle-1",
    bundleName: "Handbook",
    userId: "user-1",
    status: "active",
    pausedReason: null,
    needsFolder: false,
    folderName: null,
    syncIntervalMinutes: 360,
    nextSyncAt: Date.now() + 3_600_000,
    lastSyncAt: Date.now() - 3_600_000,
    documentCount: 12,
    createdAt: Date.now() - 86_400_000,
    ...overrides,
  };
}

function renderCard(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a connected source", () => {
  it("says where it puts things and when it last looked", () => {
    renderCard(<ConnectionCard connection={connection()} />);

    expect(screen.getByText(/Covan HQ/)).toBeInTheDocument();
    expect(screen.getByText(/Handbook · 12 documents/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  // A paused connection is not an error — grey, never red, and the reason has to
  // be readable where the person is looking rather than in a log.
  it("shows why the engine stopped it", () => {
    renderCard(
      <ConnectionCard
        connection={connection({
          status: "paused",
          pausedReason: "Notion refused the connection (HTTP 401).",
        })}
      />,
    );

    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText(/Notion refused the connection/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("offers nothing but a folder until a Drive connection has one", () => {
    renderCard(
      <ConnectionCard
        connection={connection({ provider: "google_drive", needsFolder: true, status: "paused" })}
      />,
    );

    expect(screen.getByText("Needs a folder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeInTheDocument();
    // Syncing all of somebody's Drive is the thing the two-step flow exists to
    // prevent, so the control is not there to be pressed by accident.
    expect(screen.queryByRole("button", { name: /Sync now/ })).not.toBeInTheDocument();
  });

  it("cannot be synced by hand while it is paused", () => {
    renderCard(<ConnectionCard connection={connection({ status: "paused" })} />);
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeDisabled();
  });

  it("keeps the documents unless asked otherwise", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard(<ConnectionCard connection={connection()} />);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(disconnect.mutate).toHaveBeenCalledWith(
      { id: "conn-1", documents: "keep" },
      expect.anything(),
    );
    confirm.mockRestore();
  });

  it("deletes them when that is what was asked", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard(<ConnectionCard connection={connection()} />);

    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(disconnect.mutate).toHaveBeenCalledWith(
      { id: "conn-1", documents: "delete" },
      expect.anything(),
    );
    confirm.mockRestore();
  });
});

describe("a source that could be connected", () => {
  const bundles = [
    { id: "bundle-1", name: "Handbook", description: null, documentCount: 3, createdAt: 0 },
  ];

  it("will not start until a bundle has been chosen", () => {
    renderCard(
      <ConnectSourceCard
        provider={{ id: "notion", label: "Notion", configured: true }}
        bundles={bundles}
      />,
    );

    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  // Hiding an unconfigured provider leaves a self-hoster reading documentation
  // for a feature their own build appears not to have.
  it("names the variables that would turn it on", () => {
    renderCard(
      <ConnectSourceCard
        provider={{ id: "google_drive", label: "Google Drive", configured: false }}
        bundles={bundles}
      />,
    );

    expect(screen.getByText(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});
