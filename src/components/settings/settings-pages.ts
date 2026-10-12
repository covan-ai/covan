import { Gauge, Settings, User, Users } from "lucide-react";

/**
 * The settings area's pages, in the order the rail lists them.
 *
 * Every page is listed for every role. What a role may change is decided on the
 * page, section by section, exactly as it was when this was one long page — a
 * rail that changed shape by role would answer "where did Members go?" with
 * silence.
 */
export const SETTINGS_PAGES = [
  { to: "/settings/account", label: "Account", icon: User },
  { to: "/settings/workspace", label: "Workspace", icon: Settings },
  { to: "/settings/members", label: "Members", icon: Users },
  { to: "/settings/usage", label: "Usage", icon: Gauge },
] as const;

/** The same rule as the sidebar: the page itself, or anything under it. */
export function isSettingsPage(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}
