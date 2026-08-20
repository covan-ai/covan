import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Container width tiers by page role. Keeps every in-app page on the same
// rhythm so screens don't drift apart. All tiers share the same padding.
const WIDTHS = {
  dashboard: "max-w-[1200px]",
  list: "max-w-4xl",
  form: "max-w-2xl",
} as const;

export type PageWidth = keyof typeof WIDTHS;

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
    <div className={cn("mx-auto px-5 py-14 lg:px-8", WIDTHS[width], className)}>{children}</div>
  );
}

/**
 * The badge — the smallest, loudest thing in a header, and the only place amber
 * appears in one (§5.4). Two to three words, sentence case, no punctuation.
 */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-sm font-semibold leading-none text-accent-orange", className)}>
      {children}
    </p>
  );
}

/**
 * The two-tone headline (§5.5) — the signature move. `turn` is the second half:
 * it goes italic and drops to the muted display grey, and that contrast is what
 * gives a header its rhythm. Roughly two-thirds of headings should use it; if
 * every one does, the device stops registering, so `turn` is optional.
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
    // The system sets a section headline at 52px, which is a marketing measure:
    // it assumes one headline per screenful. An app page stacks several
    // sections in a viewport, so the scale is stepped down one notch — the
    // ratios, weight, leading and italic turn are unchanged.
    <As
      className={cn(
        "font-dm font-medium leading-[1.05] tracking-[-0.01em]",
        As === "h1" ? "text-[38px] sm:text-[44px]" : "text-[28px] sm:text-[32px]",
        className,
      )}
    >
      {children}
      {turn ? (
        <>
          <br />
          <em className="font-medium italic text-display-muted">{turn}</em>
        </>
      ) : null}
    </As>
  );
}

/**
 * Page header. Badge, two-tone headline, lede — the centred/stacked shape from
 * §5.2, with an optional action pulled to the right.
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
  /** The italic second half of the headline. */
  turn?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex flex-col gap-3">
        {badge ? <Badge>{badge}</Badge> : null}
        <Headline as="h1" turn={turn}>
          {title}
        </Headline>
        {subtitle ? (
          <p className="max-w-[520px] text-base leading-[1.45] text-muted-foreground">{subtitle}</p>
        ) : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A section header inside a page: the split shape from §5.1 when a description
 * is present (heading left, lede right, baselines aligned), stacking below
 * 900px. `meta` carries a quiet count; `action` a button.
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
    <div className={cn("flex flex-wrap items-end justify-between gap-x-10 gap-y-4", className)}>
      <div className="flex min-w-0 flex-col gap-2">
        {badge ? <Badge>{badge}</Badge> : null}
        <Headline turn={turn}>{title}</Headline>
      </div>
      {description ? (
        <p className="max-w-[420px] flex-1 text-base leading-[1.35] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {meta ? <span className="text-[13px] tabular-nums text-muted-foreground">{meta}</span> : null}
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** The 12px uppercase eyebrow that labels a block inside a panel (§7.7). */
export function PanelEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </div>
  );
}
