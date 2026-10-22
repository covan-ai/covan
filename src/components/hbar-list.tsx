import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type HBar = {
  key: string;
  /** A mark or an avatar before the name. */
  lead?: ReactNode;
  label: ReactNode;
  value: number;
  /** The number as written beside the bar, when it is not just `value`. */
  display?: ReactNode;
};

/**
 * Horizontal bars, longest first (Main: Spend by agent, Team): a name column,
 * the bar, the figure. The current period is the ink-grey bar; counts of
 * people are drawn in the lighter `bar-prev` so they never read as money.
 */
export function HBarList({
  rows,
  label,
  tone = "bar",
  nameWidth = 120,
  valueWidth = 44,
  className,
}: {
  rows: HBar[];
  label: string;
  tone?: "bar" | "prev";
  nameWidth?: number;
  valueWidth?: number;
  className?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className={cn("m-0 list-none p-0", className)}>
      {rows.map((r) => {
        const share = max > 0 ? r.value / max : 0;
        return (
          <li
            key={r.key}
            className="grid min-h-8 items-center gap-3"
            style={{ gridTemplateColumns: `${nameWidth}px minmax(0,1fr) ${valueWidth}px` }}
          >
            <span className="flex min-w-0 items-center gap-2 text-meta font-medium">
              {r.lead}
              <span className="truncate">{r.label}</span>
            </span>
            <span
              aria-hidden
              className={cn(
                "block h-2.5 rounded-r-[4px]",
                tone === "bar" ? "bg-bar" : "bg-bar-prev",
              )}
              style={{
                width: share > 0 ? `max(2px, ${Math.round(share * 100)}%)` : 0,
              }}
            />
            <span className="text-right text-meta text-foreground tabular-nums">
              {r.display ?? r.value.toLocaleString("en-US")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
