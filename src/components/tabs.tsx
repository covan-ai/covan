import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TAB =
  "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors";
const ON = "border-primary text-foreground";
const OFF = "border-transparent text-muted-foreground hover:text-foreground";

export type TabItem = {
  /** A resolved path: the tab is a link, and active when the path is under it. */
  href: string;
  label: ReactNode;
  count?: number;
  /** For a tab that is also active somewhere else ("Threads" on the chat). */
  activeAlso?: string[];
};

/** Tabs that are routes (DESIGN.md §6): the active one has the 2px ink underline. */
export function Tabs({ items, label }: { items: TabItem[]; label: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label={label} className="flex h-full items-stretch gap-1">
      {items.map((t) => {
        const active = [t.href, ...(t.activeAlso ?? [])].some(
          (h) => pathname === h || pathname.startsWith(`${h}/`),
        );
        return (
          <Link
            key={t.href}
            to={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(TAB, "-mb-px", active ? ON : OFF)}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="text-xs font-medium text-muted-foreground">{t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Tabs inside a page that switch what it shows, not where it is. */
export function TabsRow<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<{ value: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex h-11 items-stretch gap-1 border-b border-border"
    >
      {items.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cn(TAB, "-mb-px", t.value === value ? ON : OFF)}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="text-xs font-medium text-muted-foreground">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
