import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type React from "react";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  useNavigate: () => navigate,
}));

const readSession = vi.fn();
vi.mock("@/lib/supabase/session", () => ({ readSession }));

async function renderDoor() {
  const { Route } = await import("./index");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the door at /", () => {
  it("opens the app for somebody signed in", async () => {
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "a" } });

    await renderDoor();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("opens sign-in for somebody who is not", async () => {
    readSession.mockResolvedValue({ kind: "none" });

    await renderDoor();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sign-in", replace: true }));
  });

  /**
   * `/` is where a bookmark lands, so it is the most likely first thing a
   * returning user hits. Sending them to the sign-in page because the lookup
   * could not complete is the same wrong answer the app used to give — and here
   * it happens before they have seen a single pixel of their own workspace.
   */
  it("waits rather than sending a signed-in person to sign-in", async () => {
    readSession.mockResolvedValueOnce({ kind: "unknown" });
    readSession.mockResolvedValue({ kind: "session", session: { access_token: "a" } });

    await renderDoor();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/app", replace: true }), {
      timeout: 6000,
    });
    expect(navigate).not.toHaveBeenCalledWith({ to: "/sign-in", replace: true });
  }, 10000);
});
