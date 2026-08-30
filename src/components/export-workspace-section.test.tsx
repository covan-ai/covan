import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportWorkspaceSection } from "./export-workspace-section";

// Hoisted with the mocks for the same reason `close-account-section.test.tsx`
// does it: `vi.mock`'s factory runs before any top-level statement here, so a
// class declared below would not exist when the factory referenced it.
const { exportArchive, success, error, FakeApiError } = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Mocked whole rather than partially: the real module builds a Supabase client
// at import time, which needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { workspace: { exportArchive } },
  ApiError: FakeApiError,
}));

vi.mock("sonner", () => ({ toast: { success, error } }));

const WORKSPACE = { workspaceId: "ws-1", workspaceName: "Acme" };
const button = () => screen.getByRole("button", { name: /Download the archive|Building/ });

beforeEach(() => {
  exportArchive.mockReset();
  success.mockReset();
  error.mockReset();
});

describe("the export button", () => {
  it("asks for this workspace, not for whichever one the URL says", async () => {
    exportArchive.mockResolvedValue(undefined);
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());

    await waitFor(() => expect(exportArchive).toHaveBeenCalledWith("ws-1"));
  });

  it("names the workspace, so nobody exports the wrong one", async () => {
    // Covan switches workspaces without changing this page, and an archive of
    // the wrong team is a mistake you find out about much later.
    render(<ExportWorkspaceSection {...WORKSPACE} />);
    expect(screen.getByText(/Exports Acme, the workspace you are in\./)).toBeInTheDocument();
  });

  it("says what it is doing while it builds", async () => {
    let finish: () => void = () => {};
    exportArchive.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());

    // A whole workspace is not instant, and a button that looks idle is a
    // button somebody presses again.
    await waitFor(() => expect(button()).toBeDisabled());
    expect(screen.getByText("Building the archive…")).toBeInTheDocument();

    finish();
    await waitFor(() => expect(button()).toBeEnabled());
  });

  it("cannot be pressed twice into two archives", async () => {
    exportArchive.mockImplementation(() => new Promise<void>(() => {}));
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());
    await userEvent.click(button());

    expect(exportArchive).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all before the workspace is known", async () => {
    // `me` arrives asynchronously, and a click in that window would ask the
    // server for `/workspaces/undefined/export`.
    render(<ExportWorkspaceSection />);

    expect(button()).toBeDisabled();
    await userEvent.click(button());
    expect(exportArchive).not.toHaveBeenCalled();
  });
});

describe("when it fails", () => {
  it("passes the server's own words through", async () => {
    exportArchive.mockRejectedValue(new FakeApiError(500, "failed to read messages"));
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());

    await waitFor(() => expect(error).toHaveBeenCalledWith("failed to read messages"));
  });

  it("falls back to plain language for a failure that is not the server's", async () => {
    exportArchive.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());

    await waitFor(() => expect(error).toHaveBeenCalledWith("Could not build the export"));
  });

  it("lets you try again, because trying again is the whole remedy", async () => {
    exportArchive.mockRejectedValueOnce(new TypeError("boom")).mockResolvedValueOnce(undefined);
    render(<ExportWorkspaceSection {...WORKSPACE} />);

    await userEvent.click(button());
    await waitFor(() => expect(error).toHaveBeenCalled());
    await waitFor(() => expect(button()).toBeEnabled());

    await userEvent.click(button());
    await waitFor(() => expect(success).toHaveBeenCalledWith("Export downloaded"));
  });
});

describe("what the page promises about the file", () => {
  it("says it holds this person's view rather than the whole workspace", () => {
    render(<ExportWorkspaceSection {...WORKSPACE} />);
    expect(screen.getByText(/private chats are not in your copy/)).toBeInTheDocument();
  });

  it("warns that delivery secrets do not travel", () => {
    // Somebody restoring a workspace and finding their Slack routine silently
    // dead should have been told here, not have worked it out.
    render(<ExportWorkspaceSection {...WORKSPACE} />);
    expect(screen.getByText(/without their secrets/)).toBeInTheDocument();
  });

  it("says the chunks are left out and why", () => {
    render(<ExportWorkspaceSection {...WORKSPACE} />);
    expect(screen.getByText(/rebuilt from the documents after a restore/)).toBeInTheDocument();
  });
});
