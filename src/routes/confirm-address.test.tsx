import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const confirm = vi.fn();
vi.mock("@/lib/api-client", () => ({ api: { addressConfirmations: { confirm } } }));

/**
 * Where a "confirm this address" email lands (migration 0096). The token in
 * the fragment is the whole credential; the page takes it out of the address
 * bar and confirms only when the button is pressed — mail scanners open links.
 */
async function renderPage(url: string) {
  window.history.replaceState(null, "", url);
  const { Route } = await import("./confirm-address");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

const TOKEN = "a-token-of-at-least-sixteen-characters";

beforeEach(() => vi.clearAllMocks());
afterEach(() => window.history.replaceState(null, "", "/"));

describe("the address confirmation page", () => {
  it("takes the token out of the address bar and confirms nothing on opening", async () => {
    await renderPage(`/confirm-address#token=${TOKEN}`);

    expect(await screen.findByRole("button", { name: /confirm this address/i })).toBeVisible();
    expect(window.location.href).not.toContain(TOKEN);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms with the token when the button is pressed", async () => {
    confirm.mockResolvedValue(undefined);
    await renderPage(`/confirm-address#token=${TOKEN}`);

    await userEvent.click(await screen.findByRole("button", { name: /confirm this address/i }));

    expect(confirm).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByText(/address confirmed/i)).toBeInTheDocument();
  });

  it("says a used or old link no longer works", async () => {
    confirm.mockRejectedValue(new Error("404"));
    await renderPage(`/confirm-address#token=${TOKEN}`);

    await userEvent.click(await screen.findByRole("button", { name: /confirm this address/i }));

    expect(await screen.findByText(/no longer works/i)).toBeInTheDocument();
  });

  it("says the link is incomplete when it carries no token", async () => {
    await renderPage("/confirm-address");

    expect(await screen.findByText(/incomplete/i)).toBeInTheDocument();
  });
});
