import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import type { Progress } from "@/lib/onboarding-flow";
import { cn } from "@/lib/utils";

/** One of the three places on the bar. */
export type BarAction = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
};

/**
 * The frame the whole first run sits in: the mark, the three-part progress,
 * a floating card, and a bar that stays where it is.
 *
 * The bar is the point. Back on the left as text, the primary button on the
 * right, a skip in the middle when there is one — on every screen, in the
 * same place, so the hand learns where to go. Below `sm` it is pinned to the
 * bottom of the viewport rather than the card, which is where a thumb is.
 *
 * The primary button submits `formId` when there is one, so Enter in any
 * input on the screen advances; a screen with nothing to type gets a plain
 * click handler instead.
 */
export function WelcomeLayout({
  progress,
  title,
  subtitle,
  back,
  skip,
  primary,
  formId,
  stepKey,
  children,
}: {
  progress: Progress;
  title?: ReactNode;
  subtitle?: ReactNode;
  back?: BarAction | null;
  skip?: BarAction | null;
  /** Null on a screen whose actions are inside it (the invitation's Join). */
  primary: BarAction | null;
  formId?: string;
  /** Changes with the step, so the body arrives afresh each time. */
  stepKey: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10 pb-28 sm:pb-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight">Covan</span>
        </div>

        <WelcomeProgress progress={progress} />

        {/* Border, radius and shadow are AuthLayout's: this screen is the one
            immediately after sign-up, and changing the surface treatment
            mid-flow would read as landing somewhere else. The shadow is
            allowed because this panel genuinely floats. */}
        <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-card">
          {/* Keyed so a new step is a new element: `.step-arrive` plays once
              per element, and the base state is the settled one, so a reader
              with motion off sees the step the moment it changes. */}
          <div key={stepKey} className="step-arrive flex min-h-[460px] flex-col p-6 sm:p-7">
            {title ? (
              <div className="text-center">
                <h1 className="text-2xl font-semibold leading-[1.2] tracking-[-0.02em]">{title}</h1>
                {subtitle ? (
                  <p className="mt-2 text-base leading-[1.5] text-muted-foreground">{subtitle}</p>
                ) : null}
              </div>
            ) : null}
            <div className={cn("flex-1", title && "mt-7")}>{children}</div>
          </div>

          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card px-4 py-3 sm:static sm:border-hairline sm:px-7 sm:py-4">
            <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
              <div className="min-w-16">
                {back ? (
                  <Button
                    type="button"
                    variant="link"
                    className="px-0 text-muted-foreground hover:text-foreground"
                    onClick={back.onClick}
                    disabled={back.disabled}
                  >
                    {back.label}
                  </Button>
                ) : null}
              </div>
              <div>
                {skip ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={skip.onClick}
                    disabled={skip.disabled}
                    className="text-muted-foreground"
                  >
                    {skip.label}
                  </Button>
                ) : null}
              </div>
              {primary === null ? (
                <div className="min-w-16" />
              ) : formId ? (
                <Button type="submit" form={formId} disabled={primary.disabled}>
                  {primary.label}
                </Button>
              ) : (
                <Button type="button" onClick={primary.onClick} disabled={primary.disabled}>
                  {primary.label}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Three labelled sections, and the dots of the one you are in.
 *
 * The dots are the system's round marks: one amber for where you are, the
 * ink at low opacity for where you have been, and the border grey for what is
 * left. Only the current section shows its dots — the others are a word, so
 * the whole thing reads as a sentence rather than a ruler.
 */
export function WelcomeProgress({ progress }: { progress: Progress }) {
  return (
    <ol
      className="flex items-center justify-center gap-5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={progress.count}
      aria-valuenow={progress.index + 1}
      aria-label={`Step ${progress.index + 1} of ${progress.count}`}
    >
      {progress.sections.map((section) => (
        <li key={section.id} className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.06em]",
              section.state === "current" ? "text-foreground" : "text-micro-foreground",
            )}
          >
            {section.state === "done" ? <Check aria-hidden className="h-3 w-3" /> : null}
            {section.label}
          </span>
          {section.state === "current" && section.dots.length > 0 ? (
            <span className="flex items-center gap-1" aria-hidden>
              {section.dots.map((dot, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    dot === "current"
                      ? "bg-brand"
                      : dot === "done"
                        ? "bg-foreground/40"
                        : "bg-border",
                  )}
                />
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
