import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Filters above a list (DESIGN.md §4): 28px pills, the active one ink. On a
 * phone each has a border so it still reads as a control (A20).
 */
export function Pills<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-meta font-medium whitespace-nowrap max-lg:border",
              on
                ? "bg-primary text-primary-foreground max-lg:border-primary"
                : "text-muted-foreground hover:bg-surface max-lg:border-input",
            )}
          >
            {o.label}
            {o.count !== undefined && o.count > 0 && (
              <span
                className={cn(
                  "text-xs",
                  on ? "text-primary-foreground/80" : "text-micro-foreground",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
