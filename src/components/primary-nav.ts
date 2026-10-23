import { Folder, House, Inbox, MessageSquare, Repeat, SlidersVertical, Users } from "lucide-react";
import { msg } from "@/i18n";

/**
 * The workspace's pages, in the sidebar's order (DESIGN.md §6, the boards'
 * sidebar): Home, Inbox, Threads, Knowledge, Routines, Team. Settings is the
 * row at the foot of the sidebar, not one of these — listed with `bottom` so
 * the label rule below still knows what to call its pages.
 *
 * `label` is the English key; whoever renders it says `t(label)`.
 */
export const PRIMARY_NAV = [
  { to: "/app", label: msg("Home"), icon: House },
  { to: "/inbox", label: msg("Inbox"), icon: Inbox },
  { to: "/threads", label: msg("Threads"), icon: MessageSquare },
  { to: "/knowledge", label: msg("Knowledge"), icon: Folder },
  { to: "/routines", label: msg("Routines"), icon: Repeat },
  { to: "/team", label: msg("Team"), icon: Users },
  { to: "/settings", label: msg("Settings"), icon: SlidersVertical, bottom: true },
] as const;

/** The rows at the top of the sidebar: everything but Settings. */
export const PAGE_NAV = PRIMARY_NAV.filter((n) => !("bottom" in n));

/** Kept for the old panel until the new sidebar replaces it. */
export const PANEL_NAV = PAGE_NAV;

export type PrimaryNavItem = (typeof PRIMARY_NAV)[number];

/** The page a path belongs to: the longest `to` it is at or under. */
export function primaryNavMatch(pathname: string): PrimaryNavItem | undefined {
  return PRIMARY_NAV.filter((n) => pathname === n.to || pathname.startsWith(`${n.to}/`)).sort(
    (a, b) => b.to.length - a.to.length,
  )[0];
}

export function pageLabel(pathname: string): string {
  return primaryNavMatch(pathname)?.label ?? "Covan";
}
