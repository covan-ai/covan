import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Play } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { Avatar } from "@/components/avatar";
import { Chip } from "@/components/chip";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { StatusDot, StatusWord } from "@/components/status-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RoutineWebhookCard } from "@/components/routines/routine-webhook-card";
import { RoutineEventCard } from "@/components/routines/routine-event-card";
import { RoutineOutputCard } from "@/components/routines/routine-output-card";
import { RoutineBrowserCard } from "@/components/routines/routine-browser-card";
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
} from "@/components/ui/alert-dialog";
import { cronToProse } from "@/lib/cron-to-prose";
import { formatRelative } from "@/lib/relative-time";
import { lastActivityLabel } from "@/lib/day-groups";
import type { Routine, RoutineRun, RunOutcome, UpdateRoutineInput } from "@/lib/routines-api";
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
  if (routine.sourceKind === "none") return "Scheduled task";
  if (routine.sourceKind === "connection") {
    const connection = connections.find((c) => c.id === routine.connectionId);
    if (!connection) return "A connected source";
    const scope = connection.folderName ?? connection.bundleName;
    return `Connected · ${connection.accountLabel}${scope ? ` · ${scope}` : ""}`;
  }
  return `${routine.sourceKind.toUpperCase()} · ${routine.sourceUrl ?? ""}`;
}

/**
 * What started a run, in the words its row says it (0109) — or nothing, for
 * the schedule, which is what a routine does unless something else is said.
 * A run from before the column existed says nothing either, which is true:
 * nothing recorded it.
 */
function runTriggerText(run: RoutineRun): string | null {
  switch (run.triggeredBy) {
    case "event":
      return run.triggerLabel ?? "An app event";
    case "webhook":
      return "Webhook";
    case "manual":
      return "Run now";
    case "reply":
      return run.triggerLabel ?? "A reply";
    case "test":
      return "A test";
    default:
      return null;
  }
}

const STOPPED_SHORT: ReadonlySet<RunOutcome> = new Set([
  "cut_short",
  "budget",
  "tokens",
  "runtime",
  "truncated",
  "empty",
]);

/** "6 min", "4 min so far", "—". */
function durationWords(run: RoutineRun, running: boolean): string {
  if (run.durationMs === null) return running ? "Under way" : "—";
  const min = Math.round(run.durationMs / 60_000);
  if (min >= 1) return `${min} min`;
  return `${Math.max(1, Math.round(run.durationMs / 1000))} s`;
}

/**
 * The Result column (A7): a dot and what came of it — how many new items,
 * what the per-run cap dropped (those were marked seen and are gone, not
 * queued), whether it was filed, and what did not get delivered.
 */
function RunResult({ run }: { run: RoutineRun }) {
  const stoppedShort =
    run.status === "ok" && run.outcome !== null && STOPPED_SHORT.has(run.outcome);
  if (run.status === "failed") {
    return (
      <StatusWord state="failed" className="max-w-[22rem]">
        <span className="truncate">Failed{run.error ? ` · ${run.error}` : ""}</span>
      </StatusWord>
    );
  }
  if (run.status === "waiting") {
    // Not delivered yet and not a failure: the report is written and held
    // until the browser task it started answers (0100).
    return <StatusWord state="waiting">Waiting on the browser</StatusWord>;
  }
  if (run.status === "skipped") {
    // "Nothing to report" is a judgement the model made, and the count is what
    // gives anyone a way to check it; "No action needed" is that there was
    // nothing new to read.
    return (
      <StatusWord state="idle">
        {run.nothingRelevant
          ? `Nothing to report${run.itemsNew > 0 ? ` · ${run.itemsNew} reviewed` : ""}`
          : "No action needed"}
      </StatusWord>
    );
  }
  const parts = [
    stoppedShort ? "Stopped before it finished" : "Done",
    run.itemsNew > 0 ? `${run.itemsNew} new ${run.itemsNew === 1 ? "item" : "items"}` : null,
    run.itemsOverflow > 0 ? `${run.itemsOverflow} skipped` : null,
    run.documentId !== null ? "Filed" : null,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-col">
      <StatusWord state="done">{parts.join(" · ")}</StatusWord>
      {/* What did not go where it should have: a channel that refused, or a
          filing that did not happen. Muted, because the run did deliver. */}
      {(run.deliveryNote || run.filingNote) && (
        <span className="truncate pl-4 text-xs text-muted-foreground">
          {[run.deliveryNote, run.filingNote].filter(Boolean).join(" · ")}
        </span>
      )}
    </span>
  );
}

/**
 * The run itself: its thread when it has one (0123), otherwise what it said,
 * for runs from before run threads — the only copy if the mail never came.
 */
function RunOpen({ run, agentId }: { run: RoutineRun; agentId: string }) {
  const [open, setOpen] = useState(false);
  if (run.sessionId) {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link to="/agents/$agentId/chat" params={{ agentId }} search={{ s: run.sessionId }}>
          Open
        </Link>
      </Button>
    );
  }
  if (!run.summary) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Summary
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>What it delivered</DialogTitle>
          </DialogHeader>
          <p className="m-0 max-h-[60vh] overflow-y-auto text-sm whitespace-pre-wrap">
            {run.summary}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A routine's when, in the kv's words: "Every Monday at 09:00 · Europe/Istanbul". */
function runsWords(routine: Routine): string {
  if (routine.triggerKind === "event") {
    return routine.event
      ? `When ${routine.event.app} · ${routine.event.label}`
      : "When something happens in an app";
  }
  if (routine.triggerKind === "webhook") return "When something calls its webhook";
  return `${cronToProse(routine.scheduleCron)} · ${routine.timezone}`;
}

/**
 * One routine (A7): a 48px bar with its name, its agent, its state and what
 * can be done to it; then its schedule, its instructions, where it delivers
 * and its recent runs, each under its own eyebrow.
 */
export function RoutineDetail({
  routine,
  runs,
  agent,
  createdByName,
  runningSince,
  connections = [],
  bundles = [],
  attachedBundleIds = [],
  canWrite = true,
  channelLabels,
  isOwner,
  onTogglePause,
  onDelete,
  onToggleShared,
  onSave,
  onRunNow,
  running,
  busy,
  editHref,
}: {
  routine: Routine;
  runs: RoutineRun[];
  /** The routine's agent, for its chip. */
  agent?: { id: string; name: string; avatar?: string | null };
  createdByName: string | null;
  /** When the run under way started, or null. */
  runningSince: number | null;
  /**
   * The workspace's connections, so a `connection` routine can be named by the
   * account it watches rather than by a uuid.
   */
  connections?: Connection[];
  /** The workspace's folders, for where a routine files its result. */
  bundles?: Array<{ id: string; name: string }>;
  /** Which of them this routine's agent reads, so the filing card can say so. */
  attachedBundleIds?: string[];
  /**
   * Whether the caller may write to the workspace's knowledge. Only used to
   * stop the filing card promising something a viewer's runs will not do.
   */
  canWrite?: boolean;
  /**
   * The channels it delivers to, by kind, named — null when the viewer is not
   * the owner, whose channels RLS keeps to them.
   */
  channelLabels: { email: string[]; slack: string[] } | null;
  isOwner: boolean;
  onTogglePause: () => void;
  onDelete: () => void;
  onToggleShared: (shared: boolean) => void;
  /** Any other patch this screen makes. */
  onSave?: (patch: UpdateRoutineInput) => void;
  onRunNow: () => void;
  /** A manual run is synchronous and can take a while — the LLM call is in it. */
  running: boolean;
  busy: boolean;
  /** The editor, for the owner (A28). */
  editHref?: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = runningSince
    ? { dot: "running" as const, word: "Running" }
    : routine.status === "paused"
      ? { dot: "idle" as const, word: "Paused" }
      : routine.status === "completed"
        ? { dot: "done" as const, word: "Finished" }
        : { dot: "done" as const, word: "Active" };
  const outputName = bundles.find((b) => b.id === routine.outputBundleId)?.name ?? null;
  const edit = editHref ? (
    <Link to={editHref} className="hover:text-foreground">
      Edit
    </Link>
  ) : undefined;

  return (
    <>
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 lg:px-6">
        <h2 className="m-0 min-w-0 truncate text-lead font-semibold">{routine.name}</h2>
        {agent && (
          <Chip>
            <AgentMark agent={agent} size={16} />
            {agent.name}
          </Chip>
        )}
        <Chip>
          <StatusDot state={state.dot} />
          {state.word}
        </Chip>
        {isOwner && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* A completed routine has nothing to pause and nothing to resume
                into: `ends_after_runs` ran its course, and "Resume" would read
                as an invitation to restart a finished series. */}
            {routine.status !== "completed" && (
              <Button variant="secondary" onClick={onTogglePause} disabled={busy}>
                {routine.status === "active" ? "Pause" : "Resume"}
              </Button>
            )}
            {/* The one primary action here. Without it the only way to find
                out whether a routine works is to wait for its schedule. */}
            <Button onClick={onRunNow} disabled={running || busy}>
              <Play />
              {running ? "Running…" : "Run now"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon" aria-label={`More for ${routine.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {editHref && (
                  <DropdownMenuItem asChild>
                    <Link to={editHref}>Edit</Link>
                  </DropdownMenuItem>
                )}
                {/* Never for a `workspace` routine: 0076 refuses sharing one
                    outright, since every report it delivers is the whole
                    workspace's gaps. */}
                {routine.sourceKind !== "workspace" && (
                  <DropdownMenuItem onClick={() => onToggleShared(routine.visibility !== "shared")}>
                    {routine.visibility === "shared" ? "Make private" : "Share with team"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete routine
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="px-4 pt-2 pb-12 lg:px-8">
        <div className="max-w-[760px]">
          <section className="mt-6">
            <SectionLabel action={edit}>Schedule</SectionLabel>
            <dl className="m-0">
              <Kv label="Runs">{runsWords(routine)}</Kv>
              {routine.triggerKind !== "event" && routine.triggerKind !== "webhook" && (
                <Kv label="Cron">
                  <Chip tone="code">{routine.scheduleCron}</Chip>
                </Kv>
              )}
              <Kv label="Next run">
                {routine.status === "active" && routine.triggerKind === "event"
                  ? "When the event arrives"
                  : routine.status === "active" && routine.nextRunAt !== null
                    ? `${new Date(routine.nextRunAt).toLocaleDateString("en-GB", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })} · ${formatRelative(routine.nextRunAt)}`
                    : routine.status === "completed"
                      ? "Finished"
                      : "Paused"}
              </Kv>
              <Kv label="Created by">
                <span className="inline-flex items-center gap-2">
                  <Avatar name={createdByName} size={20} />
                  {createdByName ?? "A teammate"} · {formatRelative(routine.createdAt)}
                </span>
              </Kv>
              {routine.sourceKind !== "none" && (
                <Kv label="Reads">{sourceLabel(routine, connections)}</Kv>
              )}
            </dl>
          </section>

          <section className="mt-7">
            <SectionLabel action={edit}>Instructions</SectionLabel>
            <div className="rounded-lg border border-border px-3.5 py-3 text-lead leading-[1.6] whitespace-pre-wrap text-foreground">
              {routine.instruction}
            </div>
          </section>

          <section className="mt-7">
            <SectionLabel>Delivers to</SectionLabel>
            <dl className="m-0">
              {outputName && (
                <Kv label="Knowledge">
                  <Chip tone="code">{outputName}</Chip>
                </Kv>
              )}
              {channelLabels ? (
                <>
                  {channelLabels.email.length > 0 && (
                    <Kv label="Email">{channelLabels.email.join(", ")}</Kv>
                  )}
                  {channelLabels.slack.length > 0 && (
                    <Kv label="Slack">{channelLabels.slack.join(", ")}</Kv>
                  )}
                </>
              ) : (
                <Kv label="Channel">The owner&rsquo;s channel</Kv>
              )}
              <Kv label="Inbox">
                {routine.deliverInbox
                  ? "Everyone who can use the agent sees the result as a thread"
                  : "Off"}
              </Kv>
            </dl>
          </section>

          {/* A workspace routine can never be shared or filed, so this is the
              one place that says why, for whoever opens this page checking
              exactly this feature's privacy properties. */}
          {routine.sourceKind === "workspace" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Never shared and never filed: sharing would show the whole workspace a report built so
              that nobody who asked a question can be singled out, and filing would turn what the
              team does not know into something an agent quotes back as if it did.
            </p>
          )}

          {/* Owner only: the policy on routine_triggers returns nothing to
              anybody else. */}
          {isOwner && (routine.triggerKind === "webhook" || routine.triggerKind === "both") && (
            <RoutineWebhookCard routineId={routine.id} />
          )}
          {/* Owner only: the subscription row is shown to its owner alone (0109). */}
          {isOwner && routine.triggerKind === "event" && <RoutineEventCard routine={routine} />}
          {/* Owner only, and never for a `workspace` routine (0075/0076
              refuse an output folder on that source). */}
          {isOwner && routine.sourceKind !== "workspace" && (
            <RoutineOutputCard
              routine={routine}
              bundles={bundles}
              attachedBundleIds={attachedBundleIds}
              canWrite={canWrite}
              onSave={onSave ?? (() => {})}
              saving={busy}
            />
          )}
          {isOwner && (
            <RoutineBrowserCard routine={routine} onSave={onSave ?? (() => {})} saving={busy} />
          )}

          <section className="mt-7">
            <SectionLabel>Recent runs</SectionLabel>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No runs yet
                {routine.triggerKind === "event"
                  ? " — the first one starts when the event arrives."
                  : routine.nextRunAt !== null
                    ? ` — the first one is scheduled ${formatRelative(routine.nextRunAt)}.`
                    : "."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <DataTable
                  label="Recent runs"
                  rows={runs.slice(0, 20)}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      key: "started",
                      header: "Started",
                      cell: (r) => (
                        <span className="tabular-nums">
                          {lastActivityLabel(r.startedAt)}
                          {runTriggerText(r) ? (
                            <span className="text-muted-foreground"> · {runTriggerText(r)}</span>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: "duration",
                      header: "Duration",
                      cell: (r) => (
                        <span className="text-muted-foreground">
                          {durationWords(
                            r,
                            runningSince !== null && r.startedAt >= runningSince - 1000,
                          )}
                        </span>
                      ),
                    },
                    {
                      key: "cost",
                      header: "Credits",
                      cell: (r) => (
                        <span className="text-muted-foreground tabular-nums">
                          {r.cost
                            ? r.cost.unit === "usd"
                              ? `$${r.cost.amount.toFixed(2)}`
                              : r.cost.amount.toLocaleString("en-US")
                            : "—"}
                        </span>
                      ),
                    },
                    { key: "result", header: "Result", cell: (r) => <RunResult run={r} /> },
                    {
                      key: "open",
                      header: <span className="sr-only">Open</span>,
                      className: "text-right",
                      cell: (r) => <RunOpen run={r} agentId={routine.agentId} />,
                    },
                  ]}
                />
              </div>
            )}
          </section>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {routine.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running. It waits 30 days in Settings › Export and deletion with its run
              history, and comes back paused if you restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={onDelete}>
              Delete routine
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A key and its value on one 36px line (A7). */
function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[140px_minmax(0,1fr)] items-center gap-x-4 border-b border-hairline py-1.5 text-sm last:border-b-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}
