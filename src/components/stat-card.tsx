import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * One figure and what it means (Main): a 13px label, the number at 24/600, a
 * line under it, and — for credits — a 3px meter. A card that leads somewhere
 * is a link, the whole of it.
 */
export function StatCard({
  label,
  value,
  detail,
  meter,
  to,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  /** 0 to 1: how much of something is used. */
  meter?: number;
  to?: LinkProps["to"];
  className?: string;
}) {
  const body = (
    <>
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="text-2xl leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      {detail && (
        <span className="flex items-center gap-1.5 text-meta text-muted-foreground">{detail}</span>
      )}
      {meter !== undefined && (
        <span aria-hidden className="mt-0.5 block h-[3px] rounded-full bg-border">
          <span
            className="block h-[3px] rounded-full bg-foreground"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }}
          />
        </span>
      )}
    </>
  );
  const box = cn(
    "flex min-w-0 flex-col gap-1.5 rounded-xl border border-border px-[18px] py-4",
    className,
  );
  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          box,
          "transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={box}>{body}</div>;
}
