import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export type SubNavItem = { href: string; label: string; external?: boolean; onSelect?: () => void };
export type SubNavGroup = { label: string; items: SubNavItem[] };

/**
 * Settings' 220px column (DESIGN.md §6): eyebrowed groups of 30px rows, the
 * active one on `surface`. Below `lg` it is one horizontal scroller.
 */
export function SubNav({ groups, label }: { groups: SubNavGroup[]; label: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const row = (item: SubNavItem) => {
    const active =
      !item.external && (pathname === item.href || pathname.startsWith(`${item.href}/`));
    const cls = cn(
      "flex h-[30px] shrink-0 items-center rounded-md px-2 text-sm whitespace-nowrap",
      active
        ? "bg-surface font-medium text-foreground"
        : "text-nav-foreground hover:bg-surface-muted",
    );
    if (item.onSelect) {
      return (
        <button
          key={item.label}
          type="button"
          onClick={item.onSelect}
          className={cn(cls, "text-left")}
        >
          {item.label}
        </button>
      );
    }
    if (item.external) {
      return (
        <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className={cls}>
          {item.label}
        </a>
      );
    }
    return (
      <Link
        key={item.label}
        to={item.href}
        aria-current={active ? "page" : undefined}
        className={cls}
      >
        {item.label}
      </Link>
    );
  };
  return (
    <nav
      aria-label={label}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline px-3 py-2 lg:w-[220px] lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-r lg:border-b-0 lg:px-3 lg:py-5"
    >
      {groups.map((g, i) => (
        <div key={g.label} className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5">
          <div
            className={cn(
              "hidden px-2 pb-1.5 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase lg:block",
              i > 0 && "pt-5",
            )}
          >
            {g.label}
          </div>
          {g.items.map(row)}
        </div>
      ))}
    </nav>
  );
}
