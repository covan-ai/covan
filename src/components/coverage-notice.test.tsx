import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoverageNotice } from "./coverage-notice";

const { preference, setPreference } = vi.hoisted(() => ({
  preference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { coverage: { preference, setPreference } },
  ApiError: class ApiError extends Error {},
}));

/**
 * Each call below passes its own `workspaceId`, where the brief's version
 * hardcoded `"w1"` everywhere. The dismissal hook is modelled on
 * `useChecklistDismissed`, which deliberately keeps an in-memory fallback
 * Set alongside `localStorage` (so a write that throws in private mode still
 * looks dismissed for the rest of the session — see that module's docblock).
 * That Set lives at module scope and outlives any one test's
 * `window.localStorage.clear()`, so two tests sharing one workspace id would
 * leak a dismissal from the earlier test into the later one — not a flaw in
 * the hook, which is behaving exactly as designed for a real browser session,
 * but a collision that only exists because this file runs many sessions
 * back to back. A distinct id per test is the real-world equivalent of each
 * test being its own browser session; the one test that is actually about
 * persisting across a remount (`"stays away on the next render"`) keeps a
 * single id across its own two renders, because that is the thing it proves.
 */
function renderNotice(enabled = true, workspaceId = "w1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CoverageNotice workspaceId={workspaceId} enabled={enabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  preference.mockResolvedValue({ excluded: false });
  setPreference.mockResolvedValue({ ok: true });
});

describe("the coverage notice", () => {
  it("says what is collected and what is never shown", async () => {
    renderNotice(true, "w-copy");
    expect(await screen.findByText(/topics/i)).toBeInTheDocument();
    expect(screen.getByText(/never/i)).toBeInTheDocument();
  });

  it("offers both choices", async () => {
    renderNotice(true, "w-choices");
    expect(
      await screen.findByRole("button", { name: /exclude my questions/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep me in/i })).toBeInTheDocument();
  });

  it("excludes them and goes away", async () => {
    renderNotice(true, "w-exclude");
    await userEvent.click(await screen.findByRole("button", { name: /exclude my questions/i }));
    expect(setPreference).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: /keep me in/i })).not.toBeInTheDocument();
  });

  it("goes away without a request when they stay in", async () => {
    renderNotice(true, "w-keep");
    await userEvent.click(await screen.findByRole("button", { name: /keep me in/i }));
    expect(setPreference).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /keep me in/i })).not.toBeInTheDocument();
  });

  it("stays away on the next render", async () => {
    const workspaceId = "w-persist";
    const first = renderNotice(true, workspaceId);
    await userEvent.click(await screen.findByRole("button", { name: /keep me in/i }));
    first.unmount();
    renderNotice(true, workspaceId);
    expect(screen.queryByRole("button", { name: /keep me in/i })).not.toBeInTheDocument();
  });

  it("says nothing at all while the workspace has not turned it on", () => {
    renderNotice(false, "w-disabled");
    expect(screen.queryByRole("button", { name: /keep me in/i })).not.toBeInTheDocument();
  });

  /**
   * Somebody who already chose to be excluded has been told. Showing them the
   * notice again would be asking a question they answered.
   *
   * Written against `waitFor` rather than the brief's
   * `findByText((_, el) => el?.tagName === "BODY")`: that matcher is
   * satisfied by the `<body>` element on its very first (synchronous) check,
   * since the predicate never inspects the mocked `preference` response — so
   * it resolves before the query that carries `excluded: true` has even
   * settled, and would pass just as happily if the notice flashed on screen
   * first and only hid itself later. The `waitFor` calls below keep polling
   * until the assertions themselves hold, which only becomes true once the
   * query has resolved and the component has actually hidden — the thing
   * this test exists to prove.
   */
  it("says nothing to somebody already excluded", async () => {
    preference.mockResolvedValue({ excluded: true });
    renderNotice(true, "w-already-excluded");
    await waitFor(() => expect(preference).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/turned on a coverage report/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /keep me in/i })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/keep me in/i);
  });

  it("survives storage that throws", async () => {
    const getItem = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    renderNotice(true, "w-storage-throws");
    expect(await screen.findByRole("button", { name: /keep me in/i })).toBeInTheDocument();
    getItem.mockRestore();
  });
});
