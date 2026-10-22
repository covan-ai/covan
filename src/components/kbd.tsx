import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A keycap (DESIGN.md §4): 11px on white with the input border. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-sm border border-input bg-card px-[5px] font-sans text-[11px] leading-[1.3] text-micro-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
