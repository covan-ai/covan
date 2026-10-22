import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The 12px uppercase eyebrow over a group (DESIGN.md §7), with a link on the right. */
export function SectionLabel({
  children,
  action,
  className,
  as: Tag = "h3",
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  as?: "h2" | "h3" | "div";
}) {
  return (
    <div className={cn("mt-8 mb-2 flex h-7 items-center justify-between first:mt-0", className)}>
      <Tag className="m-0 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
        {children}
      </Tag>
      {action && <div className="text-meta font-medium text-muted-foreground">{action}</div>}
    </div>
  );
}

/** A page section's 20/600 title and its one-sentence lede. */
export function SectionTitle({
  title,
  lede,
  action,
  className,
}: {
  title: ReactNode;
  lede?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="m-0 text-xl font-semibold tracking-[-0.01em]">{title}</h2>
        {lede && <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">{lede}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
