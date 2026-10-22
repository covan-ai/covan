import { Link } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A sidebar row's look (DESIGN.md §6): 32px, 6px radius; hover and active by fill alone. */
export const NAV_ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-nav-foreground transition-colors hover:bg-sidebar-hover";
export const NAV_ROW_ON = "bg-sidebar-accent text-foreground hover:bg-sidebar-accent";

export function NavRow({
  to,
  icon: Icon,
  label,
  active,
  count,
  trailing,
  onNavigate,
}: {
  to: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  active: boolean;
  count?: number;
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(NAV_ROW, active && NAV_ROW_ON)}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs font-medium text-muted-foreground">{count}</span>
      )}
      {trailing}
    </Link>
  );
}
