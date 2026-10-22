import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A label (DESIGN.md §4): 22px, 4px radius, 12px medium. `neutral` is the
 * default; `ink` marks the one thing that is yours or chosen ("Owner");
 * `code` is an id, a cron string, a file or a model name, in mono.
 */
export function Chip({
  tone = "neutral",
  size = "md",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "ink" | "code";
  size?: "md" | "sm";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-sm px-2 text-xs font-medium whitespace-nowrap",
        size === "md" ? "h-[22px]" : "h-5",
        tone === "ink" ? "bg-primary text-primary-foreground" : "bg-surface text-chip-foreground",
        tone === "code" && "font-mono",
        className,
      )}
      {...props}
    />
  );
}
