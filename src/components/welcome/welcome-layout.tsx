import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The frame the whole first run sits in. Same hero glow and mark as the sign-in
 * screens, wider, and with a step indicator where AuthLayout puts a footer
 * link — there is nowhere to go from here but forward.
 */
export function WelcomeLayout({
  title,
  subtitle,
  stepIndex,
  stepCount,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Zero-based. */
  stepIndex: number;
  stepCount: number;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-hero-glow px-4 py-12">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-center gap-2">
          <BrandMark className="shadow-glow" />
          <span className="text-sm font-semibold tracking-tight">Covan</span>
        </div>

        {/* Border, radius and shadow are AuthLayout's, not a fresh choice: this
            screen is the one immediately after sign-up, and changing the
            surface treatment mid-flow would read as landing somewhere else.
            The shadow is allowed here because this panel genuinely floats. */}
        <div className="rounded-2xl border border-hairline bg-card p-7 shadow-elegant">
          <div className="text-center">
            <h1 className="font-dm text-[28px] font-medium leading-tight tracking-tight">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-2 text-[15px] leading-[1.45] text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div className="mt-7">{children}</div>
        </div>

        <StepIndicator index={stepIndex} count={stepCount} />
      </div>
    </div>
  );
}

/**
 * Squares, because that is how this system marks a position — the same 8px
 * square TabButton uses on the home screen. One amber, the rest neutral, so the
 * accent stays a pointer rather than a decoration.
 */
function StepIndicator({ index, count }: { index: number; count: number }) {
  return (
    <div
      className="mt-6 flex items-center justify-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={index + 1}
      aria-label={`Step ${index + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cn("h-2 w-2 shrink-0", i === index ? "bg-accent-orange" : "bg-border")}
        />
      ))}
    </div>
  );
}
