import { Link } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { firstWeekRemaining, type FirstWeekStep } from "@/lib/first-week";

/**
 * The first-week checklist: quiet, finite, and gone when it is finished.
 *
 * It sits under the composer rather than over it, because the composer is the
 * product and this is scaffolding. It is not shown at all to a viewer (three of
 * the four steps are things the policies refuse them), to a workspace with no
 * agents (that screen has one job, and the composer above already says it), or
 * once every step is done.
 */
export function FirstWeekChecklist({
  steps,
  agentId,
  onDismiss,
}: {
  steps: FirstWeekStep[];
  /** Whichever agent the two agent-scoped links should point at. */
  agentId: string;
  onDismiss: () => void;
}) {
  const remaining = firstWeekRemaining(steps);
  const done = steps.length - remaining;

  return (
    <SectionCard className="mt-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-dm text-[17px] font-medium leading-tight">Getting set up</h2>
          <p className="mt-1 text-sm leading-[1.45] text-muted-foreground">
            {done} of {steps.length} done. This disappears when it is finished.
          </p>
        </div>
        {/* A checklist you cannot put down is a nag. Somebody who is never
            going to schedule a routine should be able to say so once. */}
        <button
          onClick={onDismiss}
          aria-label="Hide the setup checklist"
          className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-surface hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-5 flex flex-col gap-3.5">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3">
            {/* No circles — §3.5 allows exactly two, and neither is this. A
                done step gets the amber tick; an open one gets the dashed
                tile the Team page already uses for something still waiting. */}
            {step.done ? (
              <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-sm bg-accent-orange text-[#251f19]">
                <Check className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span className="mt-px h-5 w-5 shrink-0 rounded-sm border border-dashed border-border" />
            )}
            <div className="min-w-0">
              <div
                className={
                  step.done ? "text-sm text-muted-foreground line-through" : "text-sm font-medium"
                }
              >
                {step.label}
              </div>
              {!step.done && (
                <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">
                  {step.hint} <StepLink step={step} agentId={agentId} />
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * Where to go to do it. "Ask it something" has no link on purpose: the place
 * to do that is the composer directly above, and a link that scrolls you three
 * inches up is worse than no link.
 */
function StepLink({ step, agentId }: { step: FirstWeekStep; agentId: string }) {
  const className = "text-foreground underline underline-offset-4";

  switch (step.key) {
    case "knowledge":
      return (
        <Link to="/agents/$agentId/knowledge" params={{ agentId }} className={className}>
          Upload one
        </Link>
      );
    case "team":
      return (
        <Link to="/team" className={className}>
          Invite someone
        </Link>
      );
    case "routine":
      return (
        <Link to="/agents/$agentId/routines" params={{ agentId }} className={className}>
          Set one up
        </Link>
      );
    case "ask":
      return null;
  }
}
