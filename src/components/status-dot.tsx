import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DOT_WORDS, type DotState } from "@/lib/dot-states";

/**
 * The five states of a dot (DESIGN.md §12). Fill against ring is the
 * distinction, so it reads with motion switched off and in either theme:
 * running breathes amber, waiting on you is an amber ring, done is a grey
 * fill, idle a grey ring, failed red.
 */
const MARK: Record<DotState, string> = {
  running: "bg-brand dot-live",
  waiting: "border-2 border-brand",
  done: "bg-dot-done",
  idle: "border-2 border-dot-done",
  failed: "bg-destructive",
};

/**
 * An 8px dot. Silent to a screen reader unless it is given a `label`: it
 * always sits beside a word that says the same thing, or inside a control
 * whose own label does.
 */
export function StatusDot({
  state,
  label,
  className,
}: {
  state: DotState;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", MARK[state], className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

/** A dot and its word: "Running · step 3", "Done". */
export function StatusWord({
  state,
  children,
  className,
}: {
  state: DotState;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm whitespace-nowrap", className)}>
      <StatusDot state={state} />
      {children ?? DOT_WORDS[state]}
    </span>
  );
}
