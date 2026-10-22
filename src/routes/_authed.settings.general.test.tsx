import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { Me } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

let me: Me;
const update = vi.fn();
const requestDeletion = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    me: () => Promise.resolve(me),
    workspace: {
      update: (...a: unknown[]) => update(...a),
      requestDeletion: (...a: unknown[]) => requestDeletion(...a),
      cancelDeletion: vi.fn(),
      setIcon: vi.fn(),
      removeIcon: vi.fn(),
    },
    coverage: { setEnabled: vi.fn() },
    exports: { request: vi.fn() },
  },
  assetSrc: (p: string) => p,
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route } = await import("./_authed.settings.general");

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  requestDeletion.mockResolvedValue({ deletesAt: Date.now() });
  me = meFixture();
});

describe("/settings/general (A9)", () => {
  it("lays out the workspace's fields, reports and data for an admin", async () => {
    renderRoute(Route);
    const name = await screen.findByDisplayValue("Acme");
    expect(name).toBeEnabled();
    for (const label of ["Icon", "Workspace ID", "Default model tier", "Time zone"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("switch", { name: "Coverage report" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Weekly usage summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request export" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete workspace…" })).toBeInTheDocument();
  });

  it("saves the name when it is left", async () => {
    renderRoute(Route);
    const name = await screen.findByDisplayValue("Acme");
    await userEvent.clear(name);
    await userEvent.type(name, "Acme Labs{Enter}");
    expect(update).toHaveBeenCalledWith({ name: "Acme Labs" });
  });

  it("asks for the name, exactly, before scheduling the deletion", async () => {
    renderRoute(Route);
    await userEvent.click(await screen.findByRole("button", { name: "Delete workspace…" }));
    const go = await screen.findByRole("button", { name: "Delete in 14 days" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Workspace name, to confirm"), "Acme");
    await userEvent.click(go);
    expect(requestDeletion).toHaveBeenCalledWith("Acme");
  });

  it("shows a member the workspace without letting them change it", async () => {
    me = meFixture({ role: "member" });
    renderRoute(Route);
    const name = await screen.findByDisplayValue("Acme");
    await waitFor(() => expect(name).toBeDisabled());
    expect(screen.getByRole("button", { name: "Delete workspace…" })).toBeDisabled();
  });
});
