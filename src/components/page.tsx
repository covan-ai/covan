import type { ReactNode } from "react";
import { PAGE_WIDTHS, type PageWidth } from "@/lib/page-widths";
import { cn } from "@/lib/utils";

/**
 * The page under the top bar (DESIGN.md §7): 32px by 40px of padding and one
 * of six widths by what the page is — never a width of its own.
 */
export function PageBody({
  width,
  children,
  className,
}: {
  width: PageWidth;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("w-full px-4 py-6 lg:px-10 lg:py-8", PAGE_WIDTHS[width], className)}>
      {children}
    </div>
  );
}
