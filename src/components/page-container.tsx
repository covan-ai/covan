import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PAGE_WIDTHS } from "@/lib/page-widths";

export type PageWidth = keyof typeof PAGE_WIDTHS;

export function PageContainer({
  width = "list",
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mx-auto px-5 py-10 lg:px-8", PAGE_WIDTHS[width], className)}>
      {children}
    </div>
  );
}

/**
 * The eyebrow — the small uppercase label over a headline that says which
 * part of the app you are in (§5). Muted, never coloured: it is a label, not
 * a pointer. Two to three words, no punctuation.
 */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "text-xs font-semibold uppercase leading-none tracking-[0.06em] text-micro-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * A headline, with an optional second clause in the muted grey (§5). The
 * second clause is set in the same face and weight, on the same line, so the
 * two read as one sentence with its emphasis in the first half. Roughly
 * two-thirds of headings should use it; if every one does, the device stops
 * registering, so `turn` is optional.
 */
export function Headline({
  children,
  turn,
  as: As = "h2",
  className,
}: {
  children: ReactNode;
  turn?: ReactNode;
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <As
      className={cn(
        "font-semibold leading-[1.2] tracking-[-0.02em]",
        As === "h1" ? "text-2xl" : "text-xl",
        className,
      )}
    >
      {children}
      {turn ? (
        <>
          {" "}
          <span className="font-semibold text-display-muted">{turn}</span>
        </>
      ) : null}
    </As>
  );
}

/**
 * Page header. Eyebrow, headline, lede — stacked, with an optional action
 * pulled to the right and aligned to the headline's baseline.
 */
export function PageHeader({
  badge,
  title,
  turn,
  subtitle,
  action,
  children,
}: {
  badge?: ReactNode;
  title: ReactNode;
  /** The muted second clause of the headline. */
  turn?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex flex-col gap-2">
        {badge ? <Badge>{badge}</Badge> : null}
        <Headline as="h1" turn={turn}>
          {title}
        </Headline>
        {subtitle ? (
          <p className="max-w-[560px] text-sm leading-[1.5] text-muted-foreground">{subtitle}</p>
        ) : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A section header inside a page: heading left, description right on a wide
 * screen, baselines aligned, stacking below 900px. `meta` carries a quiet
 * count; `action` a button.
 */
export function SectionHeading({
  badge,
  title,
  turn,
  description,
  meta,
  action,
  className,
}: {
  badge?: ReactNode;
  title: ReactNode;
  turn?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-10 gap-y-3", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {badge ? <Badge>{badge}</Badge> : null}
        <Headline turn={turn}>{title}</Headline>
      </div>
      {description ? (
        <p className="max-w-[440px] flex-1 text-sm leading-[1.5] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {meta ? <span className="text-meta tabular-nums text-muted-foreground">{meta}</span> : null}
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** The 12px uppercase eyebrow that labels a block inside a panel (§5). */
export function PanelEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </div>
  );
}
