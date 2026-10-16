import { FolderOpen, LayoutGrid, Plug, Settings, Users } from "lucide-react";

/**
 * The sidebar's pages. Its own module, with nothing but icons imported, so the
 * matching rule below can be tested without loading the app shell (which
 * builds a Supabase client at import).
 */
export const PRIMARY_NAV = [
  { to: "/app", label: "Home", icon: LayoutGrid },
  // Above Team because it is the workspace's files rather than a setting about
  // them, and because it is the answer to "what have we written down?" — a
  // question that used to be reachable only through an agent.
  { to: "/knowledge", label: "Knowledge", icon: FolderOpen },
  // Members is a settings page, but the people in the workspace are not a
  // setting to the people in it, and Team is where everybody already looks.
  { to: "/settings/members", label: "Team", icon: Users },
  { to: "/integrations", label: "Integrations", icon: Plug },
  // Not in the panel: the rail has the one settings control, the cog at its
  // foot. Listed so the label rule below still knows what to call the pages.
  { to: "/settings", label: "Settings", icon: Settings, rail: true },
] as const;

/** The panel's rows: everything but what the rail already carries. */
export const PANEL_NAV = PRIMARY_NAV.filter((n) => !("rail" in n));

export type PrimaryNavItem = (typeof PRIMARY_NAV)[number];

/**
 * The sidebar entry a path belongs to: the page itself or anything under it,
 * and the longest such entry when two match. `/settings/members` is under
 * both Team and Settings, and without the longest-wins rule the sidebar would
 * light both rows and the context bar would say "Settings" on the Team page.
 */
export function primaryNavMatch(pathname: string): PrimaryNavItem | undefined {
  return PRIMARY_NAV.filter((n) => pathname === n.to || pathname.startsWith(`${n.to}/`)).sort(
    (a, b) => b.to.length - a.to.length,
  )[0];
}

/** Label for the context bar. Falls back to the brand on unknown paths. */
export function pageLabel(pathname: string): string {
  return primaryNavMatch(pathname)?.label ?? "Covan";
}
