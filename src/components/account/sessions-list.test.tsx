import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const revoke = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    account: {
      sessions: () =>
        Promise.resolve([
          {
            id: "s2",
            device: "iPhone",
            browser: "Safari",
            current: false,
            createdAt: 0,
            lastSeenAt: Date.now() - 2 * 86_400_000,
          },
          {
            id: "s1",
            device: "Windows",
            browser: "Chrome",
            current: true,
            createdAt: 0,
            lastSeenAt: Date.now(),
          },
        ]),
      revokeSession: (id: string) => revoke(id),
    },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SessionsList } from "./sessions-list";

describe("SessionsList (A16)", () => {
  it("puts this device first, and signs any other out", async () => {
    revoke.mockResolvedValue({ ok: true });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionsList />
      </QueryClientProvider>,
    );
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/This device · Chrome on WindowsNow/);
    expect(rows[1]).toHaveTextContent(/iPhone · Safari/);
    // Never this one: the way out of this browser is the account menu.
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(revoke).toHaveBeenCalledWith("s2");
  });
});
