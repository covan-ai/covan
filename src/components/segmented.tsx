import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One of a few, side by side in a bordered box (A16's Theme, A6's list or grid). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-md border border-input"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-[30px] items-center gap-1.5 border-r border-input px-3 text-meta font-medium last:border-r-0",
              on
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-surface-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
