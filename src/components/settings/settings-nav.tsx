import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_HOME } from "@/lib/docs";
import { SETTINGS_GROUPS, SETTINGS_PAGES, isSettingsPage } from "./settings-pages";

const ROW =
  "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200";
const ROW_IDLE = "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
const ROW_ACTIVE = "bg-sidebar-accent text-sidebar-accent-foreground";

/**
 * The column on the left of the settings card: the way back, the heading, and
 * the pages under the heading each belongs to.
 *
 * Active state comes from the pathname rather than `Link`'s `activeProps`, so
 * the one rule above decides it here and in the tests alike.
 */
export function SettingsNav({ workspaceName }: { workspaceName?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      <Link to="/app" className={cn(ROW, ROW_IDLE)}>
        <ArrowLeft className="h-4 w-4" />
        Back to app
      </Link>

      <div className="mb-2 mt-4 px-3">
        <div className="text-title-lg font-semibold">Settings</div>
        <div className="truncate text-meta text-muted-foreground">{workspaceName ?? "…"}</div>
      </div>

      {SETTINGS_GROUPS.map((group) => (
        <div key={group.key} className="mt-3">
          <Eyebrow>{group.label}</Eyebrow>
          {SETTINGS_PAGES.filter((page) => page.group === group.key).map((page) => {
            const active = isSettingsPage(pathname, page.to);
            const Icon = page.icon;
            return (
              <Link
                key={page.to}
                to={page.to}
                aria-current={active ? "page" : undefined}
                className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
              >
                <Icon className={cn("h-4 w-4", active && "text-brand")} />
                {page.label}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="mt-3">
        <Eyebrow>Help</Eyebrow>
        <a href={DOCS_HOME} target="_blank" rel="noreferrer" className={cn(ROW, ROW_IDLE)}>
          <BookOpen className="h-4 w-4" />
          Documentation
        </a>
      </div>
    </nav>
  );
}

/** The same pages as a row of tabs, for a screen too narrow for the column. */
export function SettingsTabs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Settings pages" className="flex gap-1 overflow-x-auto">
      {SETTINGS_PAGES.map((page) => {
        const active = isSettingsPage(pathname, page.to);
        const Icon = page.icon;
        return (
          <Link
            key={page.to}
            to={page.to}
            aria-current={active ? "page" : undefined}
            className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
          >
            <Icon className={cn("h-4 w-4", active && "text-brand")} />
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The 12px uppercase eyebrow, the system's one uppercase role. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </div>
  );
}
