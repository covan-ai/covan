import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A card sitting on the canvas: white, a 1px line, 10px radius, and the
 * hairline shadow. Depth is one surface step and one line; a card never gets
 * the floating shadow a panel does (§3).
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
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-xs",
        padded && "p-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A panel that genuinely floats — white, 14px radius, a line, and the one
 * floating shadow in the system. Its optional title bar is a plain strip on
 * the muted surface; there is no window chrome.
 */
export function Panel({
  title,
  className,
  children,
}: {
  /** The title bar's label. Omit for a bare panel. */
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-3xl border border-border bg-popover shadow-card",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center border-b border-hairline bg-surface-muted px-5 py-3">
          <span className="text-meta font-medium text-muted-foreground">{title}</span>
        </div>
      ) : null}
      <div className="p-6">{children}</div>
    </div>
  );
}

/**
 * The data row — the workhorse of §6. Icon tile, two-line main, trailing
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
        <span className="text-sm font-medium leading-tight [overflow-wrap:anywhere]">{title}</span>
        {meta ? (
          <span className="text-meta leading-tight text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      {trailing}
    </>
  );

  const classes = cn(
    "flex w-full items-center gap-3.5 rounded-lg border border-hairline bg-background px-4 py-3",
    onClick && "text-left transition-colors duration-150 hover:bg-surface-hover",
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
 * A chip. Neutral grey = off, pending, or coming soon. `on` = active, enabled,
 * shipped: the amber fill with ink text. There is no
 * third state and no red (§6). `code` carries cron strings, ids, and model
 * names.
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
        tone === "on" && "bg-brand text-brand-foreground",
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
      <p className="text-title font-semibold leading-tight">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-sm text-sm leading-[1.45] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A foldable note: a short label somebody can open, and the detail under it.
 *
 * Native `<details>` rather than a state flag and a chevron — it opens and
 * closes on its own, it is in the tab order, and a screen reader already knows
 * what it is. That is also what keeps it clear of the fifth failure mode: a
 * tooltip would put the same words behind a hover with no keyboard or
 * small-screen equivalent.
 *
 * Closed by default, always. This is for the sentence somebody needs once — a
 * methodology, a billing consequence, what a setting reaches — never for the
 * sentence that says what the thing is. That one stays on the screen.
 *
 * A bordered muted box, so it belongs inside a card or a panel. Under a page
 * headline it reads as a second surface competing with the one below it.
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
    <details className={cn("rounded-lg border border-border bg-muted/40", className)}>
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground marker:text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <div className="border-t border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
