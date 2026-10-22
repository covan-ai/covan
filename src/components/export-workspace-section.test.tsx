import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceExport } from "@/lib/api-client";

const { exportArchive, request, list, download, success, error, FakeApiError } = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  request: vi.fn(),
  list: vi.fn(),
  download: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    workspace: { exportArchive },
    exports: { request, list, download },
  },
  ApiError: FakeApiError,
}));
vi.mock("sonner", () => ({ toast: { success, error } }));

import { ExportWorkspaceSection } from "./export-workspace-section";

const exp = (over: Partial<WorkspaceExport>): WorkspaceExport => ({
  id: "e1",
  status: "ready",
  sizeBytes: 184_000_000,
  error: null,
  requestedBy: { id: "u1", name: "Mina Kaya" },
  mine: true,
  createdAt: Date.UTC(2026, 9, 20),
  finishedAt: Date.UTC(2026, 9, 20),
  expiresAt: Date.UTC(2026, 9, 27),
  ...over,
});

function renderSection(props: { workspaceId?: string; isAdmin?: boolean } = {}) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ExportWorkspaceSection workspaceId="w1" isAdmin {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
});

describe("ExportWorkspaceSection (A27)", () => {
  it("asks for an export of this workspace, prepared in the background", async () => {
    request.mockResolvedValue(exp({ status: "queued" }));
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Request export" }));
    expect(request).toHaveBeenCalledWith("w1");
    expect(success).toHaveBeenCalledWith(expect.stringMatching(/email you/));
  });

  it("lists the exports before, each the asker's to download", async () => {
    list.mockResolvedValue([
      exp({}),
      exp({ id: "e2", mine: false, requestedBy: { id: "u2", name: "Deniz" } }),
      exp({ id: "e3", status: "expired" }),
    ]);
    download.mockResolvedValue(undefined);
    renderSection();
    expect((await screen.findAllByText(/20 October 2026/)).length).toBe(3);
    expect(screen.getByText("Theirs to download")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledWith("e1");
  });

  it("says one is being prepared, and does not ask for a second", async () => {
    list.mockResolvedValue([exp({ status: "running" })]);
    renderSection();
    expect(await screen.findByRole("button", { name: "Preparing…" })).toBeDisabled();
  });

  it("can still build the archive right away, and passes the server's words through", async () => {
    exportArchive.mockRejectedValue(new FakeApiError(500, "failed to read messages"));
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Download it now instead" }));
    expect(exportArchive).toHaveBeenCalledWith("w1");
    expect(error).toHaveBeenCalledWith("failed to read messages");
  });

  it("does nothing at all before the workspace is known", () => {
    renderSection({ workspaceId: undefined });
    expect(screen.getByRole("button", { name: "Request export" })).toBeDisabled();
    expect(list).not.toHaveBeenCalled();
  });

  it("says it holds this person's view, and that delivery secrets do not travel", () => {
    renderSection();
    expect(screen.getByText(/private threads are not in your copy/)).toBeInTheDocument();
    expect(screen.getByText(/without their secrets/)).toBeInTheDocument();
  });
});
