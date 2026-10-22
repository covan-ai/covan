import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type BarAction = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
};

/**
 * The first run's frame (A14, A29): a 56px header — the lockup, three dots
 * with "Step n of 3", and "Save and exit" — then one white card holding the
 * step, its Back on the left and its one primary on the right, and a line
 * under the card saying what comes next.
 */
export function WelcomeLayout({
  progress,
  title,
  subtitle,
  lead,
  back,
  skip,
  primary,
  formId,
  stepKey,
  below,
  onExit,
  wide,
  children,
}: {
  progress: { index: number; count: number } | null;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Beside the title: the agent's mark on the documents step. */
  lead?: ReactNode;
  back?: BarAction | null;
  skip?: BarAction | null;
  primary: BarAction | null;
  formId?: string;
  stepKey: string;
  /** The line under the card: "Next: add the first documents it should know." */
  below?: ReactNode;
  onExit?: () => void;
  /** 760px rather than 720, for the documents step's two columns. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <header className="flex h-14 shrink-0 items-center gap-3 px-6">
        <BrandLockup />
        <div className="ml-auto flex items-center gap-3.5">
          {progress ? (
            <>
              <span className="flex items-center gap-1.5" aria-hidden>
                {Array.from({ length: progress.count }, (_, i) => (
                  <i
                    key={i}
                    className={cn(
                      "block size-2 rounded-full",
                      i <= progress.index ? "bg-foreground" : "bg-dot-done",
                    )}
                  />
                ))}
              </span>
              <span
                className="text-meta text-muted-foreground"
                role="status"
                aria-label={`Step ${progress.index + 1} of ${progress.count}`}
              >
                Step {progress.index + 1} of {progress.count}
              </span>
            </>
          ) : null}
          {onExit ? (
            <Button variant="ghost" onClick={onExit}>
              Save and exit
            </Button>
          ) : null}
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-4 pt-4 pb-12">
        <div
          key={stepKey}
          className={cn(
            "step-arrive w-full rounded-2xl border border-border bg-card px-6 pt-8 pb-6 shadow-xs sm:px-9",
            wide ? "max-w-[760px]" : "max-w-[720px]",
          )}
        >
          {title ? (
            <div className={cn(lead && "flex items-center gap-3")}>
              {lead}
              <h1 className="m-0 text-2xl font-semibold">{title}</h1>
            </div>
          ) : null}
          {subtitle ? (
            <p className="mt-2 mb-0 text-lead text-muted-foreground">{subtitle}</p>
          ) : null}
          <div className={cn(title && "mt-6")}>{children}</div>

          {back || skip || primary ? (
            <div className="mt-6 flex items-center justify-between gap-3">
              <div>
                {back ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={back.onClick}
                    disabled={back.disabled}
                  >
                    {back.label}
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {skip ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={skip.onClick}
                    disabled={skip.disabled}
                  >
                    {skip.label}
                  </Button>
                ) : null}
                {primary === null ? null : formId ? (
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
          ) : null}
        </div>
        {below ? <p className="mt-4 mb-0 text-meta text-muted-foreground">{below}</p> : null}
      </main>
    </div>
  );
}
