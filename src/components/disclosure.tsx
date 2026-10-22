import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The foldable note (DESIGN.md §7): how something works, folded under the
 * line that says what it is. A real `<details>`, so a keyboard and a phone
 * reach it the same way a mouse does, and it starts closed.
 */
export function Disclosure({
  label,
  className,
  children,
}: {
  /** The closed state, in one short phrase. */
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("group", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-meta text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {label}
      </summary>
      <div className="mt-1.5 pl-[18px] text-meta leading-[1.5] text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
