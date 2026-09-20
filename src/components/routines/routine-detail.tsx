import { useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { RoutineWebhookCard } from "@/components/routines/routine-webhook-card";
import { RoutineOutputCard } from "@/components/routines/routine-output-card";
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
import type { Routine, RoutineRun, UpdateRoutineInput } from "@/lib/routines-api";
import type { Connection } from "@/lib/connections-api";

/**
 * What this routine watches, in one line.
 *
 * A connection is named by its account rather than by its id, and falls back to
 * the generic phrase rather than to a bare uuid: connections are visible to the
 * whole workspace, so a miss here means the list has not loaded yet or the
 * connection has since been deleted, and neither is worth showing a uuid for.
 */
function sourceLabel(routine: Routine, connections: Connection[]): string {
  if (routine.sourceKind === "none") return "Scheduled prompt";
  if (routine.sourceKind === "connection") {
    const connection = connections.find((c) => c.id === routine.connectionId);
    if (!connection) return "A connected source";
    const scope = connection.folderName ?? connection.bundleName;
    return `Connected · ${connection.accountLabel}${scope ? ` · ${scope}` : ""}`;
  }
  return `${routine.sourceKind.toUpperCase()} · ${routine.sourceUrl ?? ""}`;
}

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
        {/* What the per-run cap declined. These were marked seen, so they are
            not waiting for the next run — they were never delivered and never
            will be. A run that shows only "10 new items" reads as complete,
            which is exactly the impression to avoid on a busy feed. */}
        {run.itemsOverflow > 0 && (
          <span className="text-muted-foreground">
            {" · "}
            <span className="tabular-nums">{run.itemsOverflow}</span> skipped
          </span>
        )}
        {/* One word, because that is the whole of what happened: the summary
            is now also a document in a bundle. No chip and no colour — filing
            is the ordinary outcome for a routine that files, and a badge on
            fifty-two consecutive rows says nothing. */}
        {run.documentId !== null && <span className="text-muted-foreground"> · Filed</span>}
      </span>
    ) : run.status === "failed" ? (
      <span className="text-sm text-destructive">{run.error ?? "Failed"}</span>
    ) : run.nothingRelevant ? (
      // A different answer to "why didn't it send me anything?" than the one
      // below: this run had entries and the agent decided none of them were
      // what you asked for. The count is not decoration — a filtered routine
      // and a broken one both look like silence from the outside, and this is
      // the only place to see that it is still reading.
      <span className="text-sm text-muted-foreground">
        Nothing relevant · <span className="tabular-nums">{run.itemsNew}</span> reviewed
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">Nothing new</span>
    );

  const when = (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatRelative(run.startedAt)}
      {run.durationMs !== null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}
    </span>
  );

  // Only ever set on a run that was supposed to file and did not, so it is
  // never on screen for the two ordinary cases. Shown without expanding the
  // row, because it is the only way anybody finds out that their scheduled
  // worker has no document storage bound, or that they were demoted to viewer
  // last month — the mail keeps arriving either way, which is exactly why
  // nothing else would tell them.
  //
  // Muted rather than red. The run succeeded; what failed is the optional half
  // of it, and colouring it as a failure would teach people to ignore the
  // colour that means one.
  const filingNote =
    run.filingNote === null ? null : (
      <p className="mt-1 pl-[1.625rem] text-xs text-muted-foreground">{run.filingNote}</p>
    );

  // Runs that sent nothing have nothing to reveal, and so do delivered runs
  // recorded before routine_runs.summary existed — there is nothing to backfill
  // those with, so they stay plain rows rather than expanding to an empty box.
  if (run.summary === null) {
    return (
      <li className="px-5 py-3">
        <div className="flex items-center gap-3">
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {when}
        </div>
        {filingNote}
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
      {filingNote}
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
  connections = [],
  bundles = [],
  attachedBundleIds = [],
  canWrite = true,
  channelLabel,
  isOwner,
  onTogglePause,
  onDelete,
  onToggleShared,
  onSave,
  onRunNow,
  running,
  busy,
  editAction,
}: {
  routine: Routine;
  runs: RoutineRun[];
  /**
   * The workspace's connections, so a `connection` routine can be named by the
   * account it watches rather than by a uuid. Empty is fine and is what a
   * routine of any other kind gets.
   */
  connections?: Connection[];
  /**
   * The workspace's knowledge bundles, for the one control that picks one.
   * Empty renders the card with nothing to choose, which is the honest state of
   * a workspace that has no bundles yet.
   */
  bundles?: Array<{ id: string; name: string }>;
  /** Which of them this routine's agent reads, so the card can say so. */
  attachedBundleIds?: string[];
  /**
   * Whether the caller may write to the workspace's knowledge. Only used to
   * stop the filing card promising something a viewer's runs will not do.
   * Defaults to true, which is what an unknown role does everywhere else here.
   */
  canWrite?: boolean;
  /** null when the viewer is not the owner — RLS hides other people's channels. */
  channelLabel: string | null;
  isOwner: boolean;
  onTogglePause: () => void;
  onDelete: () => void;
  onToggleShared: (shared: boolean) => void;
  /**
   * Any other patch this screen makes. Separate from the single-purpose
   * callbacks above because what it carries is open-ended, and optional so a
   * caller that renders this read-only does not have to invent one.
   */
  onSave?: (patch: UpdateRoutineInput) => void;
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
          <Field label="Source">{sourceLabel(routine, connections)}</Field>
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

      {/* Owner only, and only where there is something to show: the policy on
          routine_triggers returns nothing to anybody else, so a teammate would
          get an empty card and a button that 404s. */}
      {isOwner && routine.triggerKind !== "schedule" && (
        <RoutineWebhookCard routineId={routine.id} />
      )}

      {/* Owner only, for the same reason the pause and delete controls are:
          filing is a write into the workspace's knowledge, and offering the
          control to somebody whose PATCH will be refused produces an error
          they cannot act on. */}
      {isOwner && (
        <RoutineOutputCard
          routine={routine}
          bundles={bundles}
          attachedBundleIds={attachedBundleIds}
          canWrite={canWrite}
          onSave={onSave ?? (() => {})}
          saving={busy}
        />
      )}

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
