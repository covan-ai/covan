import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreferencesSection } from "./preferences-section";
import type { Me } from "@/lib/api-client";

const { preference, setPreference, notificationsGet } = vi.hoisted(() => ({
  preference: vi.fn(),
  setPreference: vi.fn(),
  notificationsGet: vi.fn(),
}));

// Not `vi.importActual`: `api-client.ts` builds a Supabase client at import
// time from `VITE_` env vars (see that module's own docblock on `ApiError`),
// so pulling in the real module here — even to keep its real exports — fails
// outside a configured app with "supabaseUrl is required."
vi.mock("@/lib/api-client", () => ({
  api: {
    coverage: { preference, setPreference },
    notifications: { get: notificationsGet },
    workspace: { update: vi.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

/**
 * `PreferencesSection` renders the real `useTheme`, which calls
 * `window.matchMedia` to resolve the "system" default. A local stub rather
 * than one in `test-setup.ts` — same reasoning
 * `_authed.agents.$agentId.chat.test.tsx` gives for its own: a global stub
 * would let a later test rely on media queries working without ever saying
 * that it does.
 */
function stubMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function meFixture(workspacePatch: Partial<Me["workspace"]> = {}): Me {
  return {
    user: { id: "u1", name: "Ada", email: "ada@acme.test", avatarUrl: null },
    workspace: {
      id: "w1",
      name: "Acme",
      slug: "acme",
      defaultModel: null,
      ...workspacePatch,
    },
    members: [],
    onboarding: { completed: true, answers: {} },
  } as unknown as Me;
}

function renderSection(workspacePatch: Partial<Me["workspace"]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PreferencesSection me={meFixture(workspacePatch)} />
    </QueryClientProvider>,
  );
}

const SWITCH_NAME = /exclude my questions from the coverage report/i;

/**
 * `findByRole` resolves as soon as the switch exists in the DOM, which is on
 * the very first render — disabled, before the preference query has
 * resolved (`disabled={!data || saving}`). Clicking that element would be a
 * no-op, not a failure, which is the dangerous kind of race: a test that
 * clicks too early still passes, just without proving anything. This waits
 * for the query to actually settle before handing the element back.
 */
async function findReadySwitch() {
  const toggle = await screen.findByRole("switch", { name: SWITCH_NAME });
  await waitFor(() => expect(toggle).toBeEnabled());
  return toggle;
}

beforeEach(() => {
  stubMatchMedia();
  localStorage.clear();
  preference.mockResolvedValue({ excluded: false });
  setPreference.mockResolvedValue({ ok: true });
  notificationsGet.mockResolvedValue({ routinePaused: true, quotaExhausted: true });
});

describe("the coverage opt-out in Preferences", () => {
  // The notice (`coverage-notice.tsx`) is told once and gone. This is the
  // other door into the same two routes, reachable whether or not the
  // workspace has ever turned the report on — "excludes before the report is
  // on" is exactly what the notice's own test file proves the route itself
  // allows, and this control must not add a gate the route never had.
  it("is visible while the workspace's report is off", async () => {
    renderSection({ gapReportEnabled: false });
    expect(await screen.findByRole("switch", { name: SWITCH_NAME })).toBeInTheDocument();
  });

  it("is visible while the workspace's report is on, too — this is not gated on it either way", async () => {
    renderSection({ gapReportEnabled: true });
    expect(await screen.findByRole("switch", { name: SWITCH_NAME })).toBeInTheDocument();
  });

  it("excludes their questions on request", async () => {
    renderSection();
    await userEvent.click(await findReadySwitch());
    expect(setPreference).toHaveBeenCalledWith(true);
  });

  // The half the notice cannot offer: somebody who already opted out can
  // come back in from the same row.
  it("lets somebody who already excluded themselves come back in", async () => {
    preference.mockResolvedValue({ excluded: true });
    renderSection();
    const toggle = await findReadySwitch();
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(setPreference).toHaveBeenCalledWith(false);
  });

  it("says what the report is and that nothing per-person is shown", async () => {
    renderSection();
    expect(await screen.findByText(/never shows names or anybody.s question/i)).toBeInTheDocument();
  });
});
