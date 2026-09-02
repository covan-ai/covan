import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecentlyDeletedSection } from "./recently-deleted-section";

const { list, restore, invalidateWorkspaceScoped, success, error, FakeApiError } = vi.hoisted(
  () => ({
    list: vi.fn(),
    restore: vi.fn(),
    invalidateWorkspaceScoped: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    FakeApiError: class FakeApiError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
  }),
);

// Mocked whole rather than partially, for the reason the neighbouring section
// tests give: the real module builds a Supabase client at import time, which
// needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { trash: { list, restore } },
  ApiError: FakeApiError,
}));

vi.mock("@/lib/workspace-queries", () => ({ invalidateWorkspaceScoped }));
vi.mock("sonner", () => ({ toast: { success, error } }));

const DAY = 86_400_000;

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "agent",
    id: "a1",
    name: "Support",
    deletedAt: Date.now() - 2 * DAY,
    deletedBy: "Ali",
    parentName: null,
    purgesAt: Date.now() + 28 * DAY,
    ...over,
  };
}

function renderSection(canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecentlyDeletedSection canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  list.mockReset();
  restore.mockReset();
  invalidateWorkspaceScoped.mockReset();
  success.mockReset();
  error.mockReset();
});

describe("recently deleted", () => {
  it("does not ask at all when the person cannot restore anything", async () => {
    renderSection(false);
    // A viewer is refused by `workspace_trash()` with a 403, so asking would
    // produce an error toast on a page they merely opened.
    await waitFor(() => expect(list).not.toHaveBeenCalled());
  });

  it("says how long is left, not just when it went", async () => {
    list.mockResolvedValue({ retentionDays: 30, items: [item()] });
    renderSection();

    expect(await screen.findByText("Support")).toBeInTheDocument();
    // The countdown is the whole reason somebody opens this section, and it is
    // computed rather than stored — the kind of arithmetic that silently drifts.
    expect(screen.getByText(/28 days left/)).toBeInTheDocument();
    expect(screen.getByText(/deleted by Ali/)).toBeInTheDocument();
  });

  it("says 'deleted' rather than guessing when the deleter is gone", async () => {
    list.mockResolvedValue({ retentionDays: 30, items: [item({ deletedBy: null })] });
    renderSection();

    expect(await screen.findByText("Support")).toBeInTheDocument();
    expect(screen.queryByText(/deleted by/)).not.toBeInTheDocument();
  });

  it("names the bundle a deleted document came out of", async () => {
    list.mockResolvedValue({
      retentionDays: 30,
      items: [item({ kind: "document", name: "notes.md", parentName: "Onboarding" })],
    });
    renderSection();

    // Two files called notes.md from different bundles are otherwise the same
    // row twice, with no way to tell which one is being restored.
    expect(await screen.findByText(/Onboarding/)).toBeInTheDocument();
  });

  it("restores by the kind the listing gave back", async () => {
    list.mockResolvedValue({ retentionDays: 30, items: [item({ kind: "bundle", id: "b9" })] });
    restore.mockResolvedValue({ ok: true });
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: /Restore/ }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith("bundle", "b9"));
    // An agent coming back brings its conversations and routines; a bundle
    // brings its documents. Everything on screen could have changed.
    await waitFor(() => expect(invalidateWorkspaceScoped).toHaveBeenCalled());
  });

  it("passes the server's wording through when the order is wrong", async () => {
    list.mockResolvedValue({ retentionDays: 30, items: [item({ kind: "document" })] });
    restore.mockRejectedValue(
      new FakeApiError(400, "restore the bundle this document belongs to first"),
    );
    renderSection();

    await userEvent.click(await screen.findByRole("button", { name: /Restore/ }));

    // The one message worth repeating verbatim: it names the button to press.
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("restore the bundle this document belongs to first"),
    );
  });

  it("promises the window rather than finality when there is nothing in it", async () => {
    list.mockResolvedValue({ retentionDays: 30, items: [] });
    renderSection();

    expect(await screen.findByText("Nothing deleted")).toBeInTheDocument();
    expect(screen.getByText(/30 days/)).toBeInTheDocument();
  });
});
