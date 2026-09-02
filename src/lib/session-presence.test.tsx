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
   * person's sidebar and then leave it empty, since nothing re-asks.
   */
  it("stays undecided when the lookup could not complete", async () => {
    readSession.mockResolvedValue({ kind: "unknown" });

    render(<Probe />);

    await waitFor(() => expect(readSession).toHaveBeenCalled());
    expect(answer()).toBe("undefined");
  });
});
