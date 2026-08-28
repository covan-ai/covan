import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeysSection } from "./api-keys-section";
import type { ApiKeyList } from "@/lib/api-client";

const { useQuery, invalidateQueries, list, create, revoke, success, error } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  invalidateQueries: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery,
  useQueryClient: () => ({ invalidateQueries }),
}));

// Mocked whole rather than partially: the real module constructs a Supabase
// client at import time, which needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { apiKeys: { list, create, revoke } },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success, error } }));

const KEY = {
  id: "key-1",
  name: "Nightly report",
  prefix: "covan_sk_ab12cd",
  createdAt: Date.parse("2026-08-01T00:00:00Z"),
  lastUsedAt: null,
};

function renderWith(data: ApiKeyList | undefined, isLoading = false) {
  useQuery.mockReturnValue({ data, isLoading });
  render(<ApiKeysSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("ApiKeysSection", () => {
  it("lists a key by name and by the head of the key, never the whole thing", () => {
    renderWith({ available: true, keys: [KEY] });

    expect(screen.getByText("Nightly report")).toBeInTheDocument();
    expect(screen.getByText(/covan_sk_ab12cd/)).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
  });

  it("says when a key was last used, once it has been", () => {
    // "never used" is a fact worth stating; a dash where a date should be reads
    // as data that failed to load.
    renderWith({
      available: true,
      keys: [{ ...KEY, lastUsedAt: Date.now() - 60_000 }],
    });

    expect(screen.queryByText(/never used/)).not.toBeInTheDocument();
    expect(screen.getByText(/last used/)).toBeInTheDocument();
  });

  it("renders nothing at all where the deployment cannot honour a key", () => {
    // Not an empty list with a create button: minting needs a signing secret,
    // and offering to make a credential nothing would accept is worse than
    // offering nothing.
    renderWith({ available: false, keys: [] });

    expect(screen.queryByRole("button", { name: /new key/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/API keys/i)).not.toBeInTheDocument();
  });

  it("renders nothing while the answer is still unknown", () => {
    renderWith(undefined, true);

    expect(screen.queryByRole("button", { name: /new key/i })).not.toBeInTheDocument();
  });

  it("says a key belongs to a person, not to the workspace", () => {
    // The consequence people are surprised by, and the reason it is on the
    // screen rather than only in the migration.
    renderWith({ available: true, keys: [KEY] });

    expect(screen.getByText(/leave this workspace and they stop working/i)).toBeInTheDocument();
  });

  it("shows the key once when it is created, and says so", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...KEY, token: "covan_sk_thewholekey" });
    renderWith({ available: true, keys: [] });

    await user.click(screen.getByRole("button", { name: /new key/i }));
    await user.type(screen.getByLabelText(/what is it for/i), "Nightly report");
    await user.click(screen.getByRole("button", { name: /create key/i }));

    expect(await screen.findByText("covan_sk_thewholekey")).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith("Nightly report");
    // The promise the interface is making, and the one thing a person has to
    // act on before closing the dialog.
    expect(screen.getByText(/only time it is shown/i)).toBeInTheDocument();
  });

  it("copies the key rather than making it be retyped", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...KEY, token: "covan_sk_thewholekey" });
    renderWith({ available: true, keys: [] });

    await user.click(screen.getByRole("button", { name: /new key/i }));
    await user.type(screen.getByLabelText(/what is it for/i), "Nightly report");
    await user.click(screen.getByRole("button", { name: /create key/i }));
    await user.click(await screen.findByRole("button", { name: /copy key/i }));

    // `userEvent.setup()` installs its own clipboard, so this reads back what
    // the component actually put there rather than what it was asked to put.
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("covan_sk_thewholekey"),
    );
  });

  it("will not create a key with no name", async () => {
    const user = userEvent.setup();
    renderWith({ available: true, keys: [] });

    await user.click(screen.getByRole("button", { name: /new key/i }));

    expect(screen.getByRole("button", { name: /create key/i })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes a key and refreshes the list", async () => {
    const user = userEvent.setup();
    revoke.mockResolvedValue({ ok: true });
    renderWith({ available: true, keys: [KEY] });

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("key-1"));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["api-keys"] });
  });
});
