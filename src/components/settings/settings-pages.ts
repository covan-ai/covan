import { DOCS_HOME } from "@/lib/docs";

/**
 * Settings' pages, as the sub-nav lists them (DESIGN.md §6, A9): what belongs
 * to the workspace, what belongs to you, and where to get help. Members is
 * the Team page — the people in a workspace are not a setting to the people
 * in it — and is listed here so an admin looking under Settings finds it.
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
    label: "Workspace",
    items: [
      { href: "/settings/general", label: "General" },
      { href: "/team", label: "Members" },
      { href: "/settings/integrations", label: "Integrations" },
      { href: "/settings/usage", label: "Usage and billing" },
      { href: "/settings/coverage", label: "Coverage" },
      { href: "/settings/api-keys", label: "API keys" },
      { href: "/settings/export", label: "Export and deletion" },
    ],
  },
  {
    label: "My account",
    items: [
      { href: "/settings/profile", label: "Profile" },
      { href: "/settings/security", label: "Security" },
      { href: "/settings/preferences", label: "Preferences" },
    ],
  },
  {
    label: "Help",
    items: [
      { href: DOCS_HOME, label: "Documentation", external: true },
      { href: "#feedback", label: "Send feedback", action: "feedback" },
    ],
  },
];

/** The settings pages that are routes under /settings, for the route check. */
export function settingsRoutes(): string[] {
  return SETTINGS_GROUPS.flatMap((g) => g.items)
    .filter((i) => !i.external && !i.action && i.href.startsWith("/settings/"))
    .map((i) => i.href);
}
