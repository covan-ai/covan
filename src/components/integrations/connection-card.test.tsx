import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Connection } from "@/lib/connections-api";
import { ConnectionCard, ConnectSourceCard } from "./connection-card";

const { update, sync, disconnect, start, reconnect } = vi.hoisted(() => ({
  update: { mutate: vi.fn(), isPending: false },
  sync: { mutate: vi.fn(), isPending: false },
  disconnect: { mutate: vi.fn(), isPending: false },
  start: { mutate: vi.fn(), isPending: false },
  reconnect: { mutate: vi.fn(), isPending: false },
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
  useReconnectConnection: () => reconnect,
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
    pausedCode: null,
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
        provider={{ id: "notion", label: "Notion", configured: false }}
        bundles={bundles}
      />,
    );

    expect(screen.getByText(/NOTION_CLIENT_ID and NOTION_CLIENT_SECRET/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  // Drive is built and works; what it does not have is Google's verification
  // for a restricted scope, so the hosted product cannot offer it yet. It says
  // that and stops — naming the variables would read as an invitation.
  it("says coming soon for a source that is not being offered yet", () => {
    renderCard(
      <ConnectSourceCard
        provider={{ id: "google_drive", label: "Google Drive", configured: false }}
        bundles={bundles}
      />,
    );

    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByText("Coming soon.")).toBeInTheDocument();
    expect(screen.queryByText(/GOOGLE_CLIENT_ID/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  // The other half of that: a deployment that HAS set the credentials gets the
  // whole card, because "coming soon" is a statement about covan.app rather
  // than about the software.
  it("offers Drive normally to a deployment that configured it", () => {
    renderCard(
      <ConnectSourceCard
        provider={{ id: "google_drive", label: "Google Drive", configured: true }}
        bundles={bundles}
      />,
    );

    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});

/**
 * What a person can do about a pause, which is decided by the code rather than
 * by the sentence beside it.
 *
 * The thing that makes this worth testing is that the wrong offer is worse than
 * no offer: Resume on a revoked grant starts a sync, fails on the first call,
 * and pauses the connection again with the message already on screen.
 */
describe("a paused connection", () => {
  const paused = (pausedCode: Connection["pausedCode"], pausedReason = "something happened") =>
    connection({ status: "paused", pausedCode, pausedReason });

  it("offers a new grant, and not Resume, when the old one was revoked", () => {
    renderCard(<ConnectionCard connection={paused("grant_revoked")} />);

    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    // And no Sync now either: there is nothing to sync with.
    expect(screen.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
  });

  it("does the same when nobody holds the grant any more", () => {
    // 0057 let the row survive its grant holder closing their account. A
    // workspace's connection that only an ex-colleague could fix would be the
    // same bug in a different place.
    renderCard(<ConnectionCard connection={{ ...paused("owner_gone"), userId: null }} />);

    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("asks the question rather than answering it when access narrowed", async () => {
    const user = userEvent.setup();
    renderCard(<ConnectionCard connection={paused("access_narrowed")} />);

    // Both answers, and the destructive one named for what it does. "Resume"
    // would not say that documents are about to be removed.
    const accept = screen.getByRole("button", { name: /remove them and resume/i });
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

    await user.click(accept);
    expect(update.mutate).toHaveBeenCalledWith({
      id: "conn-1",
      patch: { status: "active" },
    });
  });

  it("offers nothing to press when it is the operator's to fix", () => {
    renderCard(<ConnectionCard connection={paused("provider_unconfigured")} />);

    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.getByText(/An operator has to set this up again/)).toBeInTheDocument();
  });

  it("still just resumes after a run of ordinary failures", () => {
    renderCard(<ConnectionCard connection={paused("repeated_failures")} />);

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("resumes a pause somebody pressed themselves", () => {
    // No code at all, which is what a person pausing it looks like — and is
    // also what every row written before 0057 looks like.
    renderCard(<ConnectionCard connection={paused(null, "")} />);

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });
});

describe("replacing a grant on a working connection", () => {
  it("is offered quietly, without disconnecting first", async () => {
    const user = userEvent.setup();
    renderCard(<ConnectionCard connection={connection()} />);

    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    // The old route to this was disconnect-and-connect-again, which left a
    // second connection on the same bundle and orphaned the documents until a
    // later sync adopted them back.
    expect(reconnect.mutate).toHaveBeenCalledWith("conn-1", expect.anything());
  });
});
