import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import type React from "react";

const location = { pathname: "/settings/workspace" };

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: typeof location }) => unknown }) =>
    select({ location }),
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const { SettingsNav } = await import("./settings-nav");
const { SETTINGS_PAGES, isSettingsPage } = await import("./settings-pages");

const ROUTES_DIR = `${process.cwd()}/src/routes/`;

describe("the settings rail", () => {
  // The rail and the route files are two lists of the same pages, and the
  // failure is a page nobody can reach (a route with no entry) or an entry
  // that 404s (an entry with no route). Neither shows up in a render test.
  it("lists exactly the pages that exist under /settings", () => {
    const routed = readdirSync(ROUTES_DIR)
      .filter((f) => /^_authed\.settings\.[a-z-]+\.tsx$/.test(f))
      .filter((f) => !["_authed.settings.index.tsx", "_authed.settings.test.tsx"].includes(f))
      .map((f) => `/settings/${f.replace(/^_authed\.settings\./, "").replace(/\.tsx$/, "")}`)
      .sort();

    expect(SETTINGS_PAGES.map((p) => p.to).sort()).toEqual(routed);
  });

  it("treats a page and anything under it as that page, and nothing else", () => {
    expect(isSettingsPage("/settings/account", "/settings/account")).toBe(true);
    expect(isSettingsPage("/settings/account/x", "/settings/account")).toBe(true);
    expect(isSettingsPage("/settings/accounts", "/settings/account")).toBe(false);
    expect(isSettingsPage("/settings", "/settings/account")).toBe(false);
  });

  it("marks only the page you are on as current", () => {
    render(<SettingsNav />);
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Workspace");
    expect(current[0]).toHaveAttribute("aria-current", "page");
  });
});
