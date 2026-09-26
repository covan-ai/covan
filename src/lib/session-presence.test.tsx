import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { onAuthStateChange, readSession } = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  readSession: vi.fn(),
}));
vi.mock("./supabase/client", () => ({ supabase: { auth: { onAuthStateChange } } }));
vi.mock("./supabase/session", () => ({ readSession }));

const { useHasSession } = await import("./session-presence");

function Probe() {
  const hasSession = useHasSession();
  return <span data-testid="answer">{String(hasSession)}</span>;
}

const answer = () => screen.getByTestId("answer").textContent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("whether there is somebody signed in", () => {
  it("says yes when there is", async () => {
    readSession.mockResolvedValue({ kind: "session", session: {} });

    render(<Probe />);

    await waitFor(() => expect(answer()).toBe("true"));
  });

  it("says no when there is not", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    render(<Probe />);

    await waitFor(() => expect(answer()).toBe("false"));
  });

  /**
   * `false` means "nobody is signed in", and every query in the agents store is
   * gated on it. Saying it because the lookup failed would empty a signed-in
   * person's sidebar.
   */
  it("stays undecided when the lookup could not complete", async () => {
    readSession.mockResolvedValue({ kind: "unknown" });

    render(<Probe />);

    await waitFor(() => expect(readSession).toHaveBeenCalled());
    expect(answer()).toBe("undefined");
  });

  /**
   * Staying undecided is right for a moment and wrong forever.
   *
   * The hosted landing page renders its signed-out call to action for
   * `undefined` — server-rendered HTML cannot know who is asking — so a visitor
   * this hook never decides about is shown "Get started" on a machine holding a
   * perfectly good session. Nothing else corrects it: `INITIAL_SESSION` is
   * skipped on purpose, and a browser whose stored token is still valid emits
   * no further auth event to be corrected by. One inconclusive lookup on a
   * return visit and the marketing page is all they ever see, which is
   * indistinguishable from having been signed out — and is exactly how somebody
   * ends up signing in again beside a refresh token that was never used.
   *
   * Real timers rather than fake, matching `_authed`: the retry is a
   * `setTimeout` this hook owns, and what is worth asserting is that it fires
   * without anybody clicking.
   */
  it("asks again after a lookup that could not complete", async () => {
    readSession.mockResolvedValueOnce({ kind: "unknown" });
    readSession.mockResolvedValue({ kind: "session", session: {} });

    render(<Probe />);

    await waitFor(() => expect(answer()).toBe("true"), { timeout: 6000 });
  }, 10000);

  // The retry exists for a lookup that could not complete, not as a poll. Once
  // there is a real answer the asking has to stop, or every signed-out visitor
  // re-reads storage forever on the busiest page on the site.
  it("stops asking once it has an answer", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    render(<Probe />);

    await waitFor(() => expect(answer()).toBe("false"));
    await new Promise((r) => setTimeout(r, 4000));
    expect(readSession).toHaveBeenCalledTimes(1);
  }, 10000);
});
