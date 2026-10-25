import { DOCS_HOME } from "@/lib/docs";
import { msg } from "@/i18n";

/**
 * Settings' pages, as the sub-nav lists them (DESIGN.md §6, A9): what belongs
 * to the workspace, what belongs to you, and where to get help. Members is
 * the Team page — the people in a workspace are not a setting to the people
 * in it — and is listed here so an admin looking under Settings finds it.
 *
 * Every `label` is the English key; the sub-nav says `t(label)`.
 */
export type SettingsItem = {
  href: string;
  label: string;
  /** Opens elsewhere: the documentation. */
  external?: boolean;
  /** Not a page: the item does something (Send feedback). */
  action?: "feedback";
};

export const SETTINGS_GROUPS: ReadonlyArray<{ label: string; items: readonly SettingsItem[] }> = [
  {
    label: msg("Workspace"),
    items: [
      { href: "/settings/general", label: msg("General") },
      { href: "/team", label: msg("Members") },
      { href: "/settings/integrations", label: msg("Integrations") },
      { href: "/settings/usage", label: msg("Usage and billing") },
      { href: "/settings/coverage", label: msg("Coverage") },
      { href: "/settings/memory", label: msg("Memory") },
      { href: "/settings/api-keys", label: msg("API keys") },
      { href: "/settings/export", label: msg("Export and deletion") },
    ],
  },
  {
    label: msg("My account"),
    items: [
      { href: "/settings/profile", label: msg("Profile") },
      { href: "/settings/security", label: msg("Security") },
      { href: "/settings/preferences", label: msg("Preferences") },
    ],
  },
  {
    label: msg("Help"),
    items: [
      { href: DOCS_HOME, label: msg("Documentation"), external: true },
      { href: "#feedback", label: msg("Send feedback"), action: "feedback" },
    ],
  },
];

/** The settings pages that are routes under /settings, for the route check. */
export function settingsRoutes(): string[] {
  return SETTINGS_GROUPS.flatMap((g) => g.items)
    .filter((i) => !i.external && !i.action && i.href.startsWith("/settings/"))
    .map((i) => i.href);
}
