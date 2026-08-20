import { cn } from "@/lib/utils";
import type { Routine } from "@/lib/routines-api";

/**
 * Three states, expressed the way this system expresses state: a square, not a
 * dot, and amber-or-neutral rather than a traffic light. The palette allows one
 * saturated colour, so "running" is amber and "paused" is simply not amber.
 *
 * The failure case keeps `--destructive`, which is the one deliberate extension
 * to the palette: the engine pausing a routine itself after five consecutive
 * failures is exactly the event that must not read as a quiet "Paused". A
 * routine that died while the interface looked calm is the failure that
 * destroys trust in this feature, so the reason travels with the label
 * wherever the status is shown.
 */
export function RoutineStatus({ routine, className }: { routine: Routine; className?: string }) {
  const failed = routine.status === "paused" && routine.pausedReason !== null;
  const mark =
    routine.status === "active"
      ? "bg-accent-orange"
      : failed
        ? "bg-destructive"
        : "bg-muted-foreground/40";

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2 text-[13px]", className)}>
      <span className={cn("h-2 w-2 shrink-0", mark)} aria-hidden />
      {routine.status === "active" ? (
        <span className="text-muted-foreground">Active</span>
      ) : failed ? (
        <span className="min-w-0 truncate text-destructive">Paused — {routine.pausedReason}</span>
      ) : (
        <span className="text-muted-foreground">Paused</span>
      )}
    </span>
  );
}
