import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { SETTINGS_PAGES, isSettingsPage } from "./settings-pages";

/**
 * A column beside the page on a wide screen and a row of tabs above it on a
 * narrow one. Both are the same real links, so a keyboard and a thumb reach
 * every page the same way a pointer does.
 *
 * Active state comes from the pathname rather than `Link`'s `activeProps`, so
 * the one rule above decides it here and in the tests alike.
 */
export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      aria-label="Settings sections"
      className="-mx-5 mb-10 flex gap-1 overflow-x-auto px-5 lg:sticky lg:top-24 lg:mx-0 lg:mb-0 lg:flex-col lg:self-start lg:px-0"
    >
      {SETTINGS_PAGES.map((page) => {
        const active = isSettingsPage(pathname, page.to);
        const Icon = page.icon;
        return (
          <Link
            key={page.to}
            to={page.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            {/* The sidebar's mark for the row you are on (§7.2). */}
            <span
              aria-hidden
              className={cn(
                "h-1 w-1 shrink-0 transition-colors duration-200",
                active ? "bg-accent-orange" : "bg-transparent",
              )}
            />
            <Icon className="h-4 w-4" />
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}
