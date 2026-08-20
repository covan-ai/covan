import { useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { RoutineStatus } from "@/components/routines/routine-status";
import { cronToProse } from "@/lib/cron-to-prose";
import { formatRelative } from "@/lib/relative-time";
import type { Routine, RoutineRun } from "@/lib/routines-api";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 py-2">
      <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
    </div>
  );
}

function RunRow({ run }: { run: RoutineRun }) {
  const [open, setOpen] = useState(false);
  const icon =
    run.status === "ok" ? (
      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : run.status === "failed" ? (
      <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
    ) : (
      <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    );

  // `skipped` is the answer to "why didn't it send me anything?" — the engine
  // looked and there was nothing new. On a healthy feed it is the common case,
  // so it stays neutral and never reads as a failure.
  const label =
    run.status === "ok" ? (
      <span className="text-sm">
        Sent · <span className="tabular-nums">{run.itemsNew}</span> new item
        {run.itemsNew === 1 ? "" : "s"}
      </span>
    ) : run.status === "failed" ? (
      <span className="text-sm text-destructive">{run.error ?? "Failed"}</span>
    ) : (
      <span className="text-sm text-muted-foreground">Nothing new</span>
    );

  const when = (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatRelative(run.startedAt)}
      {run.durationMs !== null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}
    </span>
  );

  // Runs that sent nothing have nothing to reveal, and so do delivered runs
  // recorded before routine_runs.summary existed — there is nothing to backfill
  // those with, so they stay plain rows rather than expanding to an empty box.
  if (run.summary === null) {
    return (
      <li className="flex items-center gap-3 px-5 py-3">
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {when}
      </li>
    );
  }

  return (
    <li className="px-5 py-3">
      <div className="flex items-center gap-3">
        {icon}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 flex-1 truncate text-left hover:underline"
        >
          {label}
        </button>
        {when}
      </div>
      {open && (
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm text-muted-foreground">
          {run.summary}
        </p>
      )}
    </li>
  );
}

export function RoutineDetail({
  routine,
  runs,
  channelLabel,
  isOwner,
  onTogglePause,
  onDelete,
  onToggleShared,
  onRunNow,
  running,
  busy,
  editAction,
}: {
  routine: Routine;
  runs: RoutineRun[];
  /** null when the viewer is not the owner — RLS hides other people's channels. */
  channelLabel: string | null;
  isOwner: boolean;
  onTogglePause: () => void;
  onDelete: () => void;
  onToggleShared: (shared: boolean) => void;
  onRunNow: () => void;
  /** A manual run is synchronous and can take a while — the LLM call is in it. */
  running: boolean;
  busy: boolean;
  /** The edit dialog, passed in so this stays a presentational component. */
  editAction?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-dm text-[32px] font-medium leading-[1.05] tracking-[-0.01em]">
            {routine.name}
          </h1>
          <RoutineStatus routine={routine} className="mt-1" />
        </div>
        {isOwner && (
          <div className="flex shrink-0 items-center gap-2">
            {/* The one primary action here. Without it the only way to find out
                whether a routine works is to wait out the engine's five-minute
                tick, which makes every mistake cost a round trip to discover. */}
            <Button size="sm" onClick={onRunNow} disabled={running || busy}>
              {running ? "Running…" : "Run now"}
            </Button>
            {editAction}
            <Button variant="outline" size="sm" onClick={onTogglePause} disabled={busy}>
              {routine.status === "active" ? "Pause" : "Resume"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {routine.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the routine and its run history. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={onDelete}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      <SectionCard className="mt-8">
        <dl className="divide-y divide-hairline">
          <Field label="Source">
            {routine.sourceKind === "none"
              ? "Scheduled prompt"
              : `${routine.sourceKind.toUpperCase()} · ${routine.sourceUrl ?? ""}`}
          </Field>
          <Field label="Schedule">
            <span className="tabular-nums">{cronToProse(routine.scheduleCron)}</span> ·{" "}
            {routine.timezone}
          </Field>
          <Field label="Delivers to">{channelLabel ?? "The owner's channel"}</Field>
          <Field label="Next run">
            {routine.status === "active" && routine.nextRunAt !== null ? (
              <span className="tabular-nums">{formatRelative(routine.nextRunAt)}</span>
            ) : (
              "Paused"
            )}
          </Field>
          <Field label="Instruction">{routine.instruction}</Field>
          {/* Owner only. RLS refuses a teammate's update, so a switch here would
              produce an error they have no way to act on. */}
          {isOwner && (
            <Field label="Sharing">
              <div className="flex flex-wrap items-center gap-3">
                <Switch
                  id="routine-shared"
                  aria-label="Share with the workspace"
                  checked={routine.visibility === "shared"}
                  onCheckedChange={onToggleShared}
                  disabled={busy}
                />
                <label htmlFor="routine-shared" className="text-sm text-muted-foreground">
                  {routine.visibility === "shared"
                    ? "Visible to everyone in the workspace"
                    : "Only you"}
                </label>
              </div>
            </Field>
          )}
        </dl>
      </SectionCard>

      <section className="mt-10">
        <SectionHeading title="Run history" />
        <SectionCard padded={false} className="mt-3 overflow-hidden">
          {runs.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">
              No runs yet
              {routine.nextRunAt !== null
                ? ` — the first one is scheduled ${formatRelative(routine.nextRunAt)}.`
                : "."}
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </SectionCard>
      </section>
    </>
  );
}
