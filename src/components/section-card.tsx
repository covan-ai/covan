import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A card sitting on the canvas: one surface step up, a 1px line, 12px radius,
 * and no shadow. A grid of shadowed cards is the "bubble wrap" failure mode and
 * it is instantly off-system (§3.5) — depth here is a step, never a shadow.
 *
 * Pass `padded={false}` when the card holds its own edge-to-edge rows.
 */
export function SectionCard({
  padded = true,
  className,
  children,
}: {
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card", padded && "p-6", className)}>
      {children}
    </div>
  );
}

/**
 * A panel that genuinely floats — white (the raised state), 20px radius, and
 * the one panel shadow in the system. Its interior rows sit on `--background`,
 * one step *below* the panel, so they read as content wells (§7.7).
 */
export function Panel({
  title,
  className,
  children,
}: {
  /** The window-chrome bar's label. Omit for a bare panel. */
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("overflow-hidden rounded-3xl bg-popover shadow-card", className)}>
      {title ? (
        <div className="flex items-center gap-[7px] border-b border-hairline bg-surface-muted px-[18px] py-3.5">
          {/* One of exactly two places a circle is allowed: window chrome. */}
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
          <span className="ml-2.5 text-[13px] font-medium text-muted-foreground">{title}</span>
        </div>
      ) : null}
      <div className="p-6">{children}</div>
    </div>
  );
}

/**
 * The data row — the workhorse of §7.8. Icon tile, two-line main, trailing
 * chip. `overflow-wrap: anywhere` on the title is not optional: these rows
 * carry filenames, and at 375px a long one punches straight through the chip.
 */
export function DataRow({
  icon,
  title,
  meta,
  trailing,
  onClick,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const inner = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-[3px] text-left">
        <span className="text-[15px] font-medium leading-tight [overflow-wrap:anywhere]">
          {title}
        </span>
        {meta ? (
          <span className="text-[13px] leading-tight text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      {trailing}
    </>
  );

  const classes = cn(
    "flex w-full items-center gap-3.5 rounded-lg border border-hairline bg-background px-4 py-3.5",
    onClick && "text-left transition-colors duration-200 hover:bg-surface-hover",
    className,
  );

  return onClick ? (
    <button type="button" onClick={onClick} className={classes}>
      {inner}
    </button>
  ) : (
    <div className={classes}>{inner}</div>
  );
}

/**
 * A chip. Neutral grey = off, pending, or coming soon. Amber = active,
 * enabled, shipped. There is no third state and no red (§7.8). `code` carries
 * cron strings, ids, and model names.
 */
export function Chip({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "on" | "code" | "ink";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium leading-[1.4]",
        tone === "on" && "bg-accent-orange text-accent-orange-foreground",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "ink" && "bg-primary text-primary-foreground",
        tone === "code" && "bg-surface font-mono text-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The quiet empty state: a dashed well, one line of explanation, one action. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      <p className="font-dm text-[18px] leading-tight">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-sm text-sm leading-[1.45] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
