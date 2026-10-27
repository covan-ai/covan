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
import { RoutineChangesCard } from "@/components/routines/routine-changes-card";
import type { AgentAccess } from "@/lib/agent-access";
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
import { useTranslation, type Translate } from "@/i18n";
import { useLocale } from "@/i18n/provider";
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
function sourceLabel(routine: Routine, connections: Connection[], t: Translate): string {
  if (routine.sourceKind === "none") return t("Scheduled task");
  if (routine.sourceKind === "connection") {
    const connection = connections.find((c) => c.id === routine.connectionId);
    if (!connection) return t("A connected source");
    const scope = connection.folderName ?? connection.bundleName;
    return scope
      ? t("Connected · {{account}} · {{scope}}", { account: connection.accountLabel, scope })
      : t("Connected · {{account}}", { account: connection.accountLabel });
  }
  // i18n-ignore: the source kind is an identifier (RSS, WEB), not a word.
  return `${routine.sourceKind.toUpperCase()} · ${routine.sourceUrl ?? ""}`;
}

/**
 * What started a run, in the words its row says it (0109) — or nothing, for
 * the schedule, which is what a routine does unless something else is said.
 * A run from before the column existed says nothing either, which is true:
 * nothing recorded it.
 */
function runTriggerText(run: RoutineRun, t: Translate): string | null {
  switch (run.triggeredBy) {
    case "event":
      return run.triggerLabel ?? t("An app event");
    case "webhook":
      return t("Webhook");
    case "manual":
      return t("Run now");
    case "reply":
      return run.triggerLabel ?? t("A reply");
    case "test":
      return t("A test");
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
function durationWords(run: RoutineRun, running: boolean, t: Translate): string {
  if (run.durationMs === null) return running ? t("Under way") : "—";
  const min = Math.round(run.durationMs / 60_000);
  if (min >= 1) return t("{{count}} min", { count: min, defaultValue_other: "{{count}} min" });
  const sec = Math.max(1, Math.round(run.durationMs / 1000));
  return t("{{count}} s", { count: sec, defaultValue_other: "{{count}} s" });
}

/**
 * The Result column (A7): a dot and what came of it — how many new items,
 * what the per-run cap dropped (those were marked seen and are gone, not
 * queued), whether it was filed, and what did not get delivered.
 */
function RunResult({ run }: { run: RoutineRun }) {
  const { t } = useTranslation();
  const stoppedShort =
    run.status === "ok" && run.outcome !== null && STOPPED_SHORT.has(run.outcome);
  if (run.status === "failed") {
    return (
      <StatusWord state="failed" className="max-w-[22rem]">
        <span className="truncate">
          {t("Failed")}
          {run.error ? ` · ${run.error}` : ""}
        </span>
      </StatusWord>
    );
  }
  if (run.status === "waiting") {
    // Not delivered yet and not a failure: the report is written and held
    // until the browser task it started answers (0100).
    return <StatusWord state="waiting">{t("Waiting on the browser")}</StatusWord>;
  }
  if (run.status === "skipped") {
    // "Nothing to report" is a judgement the model made, and the count is what
    // gives anyone a way to check it; "No action needed" is that there was
    // nothing new to read.
    return (
      <StatusWord state="idle">
        {run.nothingRelevant
          ? run.itemsNew > 0
            ? t("Nothing to report · {{reviewed}} reviewed", { reviewed: run.itemsNew })
            : t("Nothing to report")
          : t("No action needed")}
      </StatusWord>
    );
  }
  const parts = [
    stoppedShort
      ? t("Stopped before it finished")
      : t("Done", { context: "status", defaultValue: "Done" }),
    run.itemsNew > 0
      ? t("{{count}} new item", { count: run.itemsNew, defaultValue_other: "{{count}} new items" })
      : null,
    run.itemsOverflow > 0 ? t("{{skipped}} skipped", { skipped: run.itemsOverflow }) : null,
    run.documentId !== null ? t("Filed") : null,
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (run.sessionId) {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link to="/agents/$agentId/chat" params={{ agentId }} search={{ s: run.sessionId }}>
          {t("Open")}
        </Link>
      </Button>
    );
  }
  if (!run.summary) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t("Summary")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t("What it delivered")}</DialogTitle>
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
function runsWords(routine: Routine, t: Translate): string {
  if (routine.triggerKind === "event") {
    return routine.event
      ? t("When {{app}} · {{event}}", { app: routine.event.app, event: routine.event.label })
      : t("When something happens in an app");
  }
  if (routine.triggerKind === "webhook") return t("When something calls its webhook");
  return `${cronToProse(routine.scheduleCron, t)} · ${routine.timezone}`;
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
  agent?: {
    id: string;
    name: string;
    avatar?: string | null;
    /** For what it may change without asking; see `RoutineChangesCard`. */
    myAccess?: AgentAccess;
    connectionsOff?: string[];
  };
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
  const { t } = useTranslation();
  const locale = useLocale();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = runningSince
    ? { dot: "running" as const, word: t("Running") }
    : routine.status === "paused"
      ? { dot: "idle" as const, word: t("Paused") }
      : routine.status === "completed"
        ? { dot: "done" as const, word: t("Finished") }
        : { dot: "done" as const, word: t("Active") };
  const teammate = t("A teammate");
  const outputName = bundles.find((b) => b.id === routine.outputBundleId)?.name ?? null;
  const edit = editHref ? (
    <Link to={editHref} className="hover:text-foreground">
      {t("Edit")}
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
                {routine.status === "active" ? t("Pause") : t("Resume")}
              </Button>
            )}
            {/* The one primary action here. Without it the only way to find
                out whether a routine works is to wait for its schedule. */}
            <Button onClick={onRunNow} disabled={running || busy}>
              <Play />
              {running ? t("Running…") : t("Run now")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t("More for {{name}}", { name: routine.name })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {editHref && (
                  <DropdownMenuItem asChild>
                    <Link to={editHref}>{t("Edit")}</Link>
                  </DropdownMenuItem>
                )}
                {/* Never for a `workspace` routine: 0076 refuses sharing one
                    outright, since every report it delivers is the whole
                    workspace's gaps. */}
                {routine.sourceKind !== "workspace" && (
                  <DropdownMenuItem onClick={() => onToggleShared(routine.visibility !== "shared")}>
                    {routine.visibility === "shared" ? t("Make private") : t("Share with team")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  {t("Delete routine")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="px-4 pt-2 pb-12 lg:px-8">
        <div className="max-w-[760px]">
          <section className="mt-6">
            <SectionLabel action={edit}>{t("Schedule")}</SectionLabel>
            <dl className="m-0">
              <Kv label={t("Runs")}>{runsWords(routine, t)}</Kv>
              {routine.triggerKind !== "event" && routine.triggerKind !== "webhook" && (
                <Kv label={t("Cron")}>
                  <Chip tone="code">{routine.scheduleCron}</Chip>
                </Kv>
              )}
              <Kv label={t("Next run")}>
                {routine.status === "active" && routine.triggerKind === "event"
                  ? t("When the event arrives")
                  : routine.status === "active" && routine.nextRunAt !== null
                    ? `${new Date(routine.nextRunAt).toLocaleDateString(locale, {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })} · ${formatRelative(routine.nextRunAt, undefined, t, locale)}`
                    : routine.status === "completed"
                      ? t("Finished")
                      : t("Paused")}
              </Kv>
              <Kv label={t("Created by")}>
                <span className="inline-flex items-center gap-2">
                  <Avatar name={createdByName} size={20} />
                  {createdByName ?? teammate} ·{" "}
                  {formatRelative(routine.createdAt, undefined, t, locale)}
                </span>
              </Kv>
              {routine.sourceKind !== "none" && (
                <Kv label={t("Reads")}>{sourceLabel(routine, connections, t)}</Kv>
              )}
            </dl>
          </section>

          <section className="mt-7">
            <SectionLabel action={edit}>{t("Instructions")}</SectionLabel>
            <div className="rounded-lg border border-border px-3.5 py-3 text-lead leading-[1.6] whitespace-pre-wrap text-foreground">
              {routine.instruction}
            </div>
          </section>

          <section className="mt-7">
            <SectionLabel>{t("Delivers to")}</SectionLabel>
            <dl className="m-0">
              {outputName && (
                <Kv label={t("Knowledge")}>
                  <Chip tone="code">{outputName}</Chip>
                </Kv>
              )}
              {channelLabels ? (
                <>
                  {channelLabels.email.length > 0 && (
                    <Kv label={t("Email")}>{channelLabels.email.join(", ")}</Kv>
                  )}
                  {channelLabels.slack.length > 0 && (
                    <Kv label={t("Slack")}>{channelLabels.slack.join(", ")}</Kv>
                  )}
                </>
              ) : (
                <Kv label={t("Channel")}>{t("The owner’s channel")}</Kv>
              )}
              <Kv label={t("Inbox")}>
                {routine.deliverInbox
                  ? t("Everyone who can use the agent sees the result as a thread")
                  : t("Off")}
              </Kv>
            </dl>
          </section>

          {/* A workspace routine can never be shared or filed, so this is the
              one place that says why, for whoever opens this page checking
              exactly this feature's privacy properties. */}
          {routine.sourceKind === "workspace" && (
            <p className="mt-3 text-meta text-muted-foreground">
              {t(
                "Never shared and never filed: sharing would show the whole workspace a report built so that nobody who asked a question can be singled out, and filing would turn what the team does not know into something an agent quotes back as if it did.",
              )}
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
          {isOwner && agent && <RoutineChangesCard agent={agent} />}

          <section className="mt-7">
            <SectionLabel>{t("Recent runs")}</SectionLabel>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {routine.triggerKind === "event"
                  ? t("No runs yet — the first one starts when the event arrives.")
                  : routine.nextRunAt !== null
                    ? t("No runs yet — the first one is scheduled {{when}}.", {
                        when: formatRelative(routine.nextRunAt, undefined, t, locale),
                      })
                    : t("No runs yet.")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <DataTable
                  label={t("Recent runs")}
                  rows={runs.slice(0, 20)}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      key: "started",
                      header: t("Started"),
                      cell: (r) => (
                        <span className="tabular-nums">
                          {lastActivityLabel(r.startedAt, undefined, t, locale)}
                          {runTriggerText(r, t) ? (
                            <span className="text-muted-foreground"> · {runTriggerText(r, t)}</span>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: "duration",
                      header: t("Duration"),
                      cell: (r) => (
                        <span className="text-muted-foreground">
                          {durationWords(
                            r,
                            runningSince !== null && r.startedAt >= runningSince - 1000,
                            t,
                          )}
                        </span>
                      ),
                    },
                    {
                      key: "cost",
                      header: t("Credits"),
                      cell: (r) => (
                        <span className="text-muted-foreground tabular-nums">
                          {r.cost
                            ? r.cost.unit === "usd"
                              ? new Intl.NumberFormat(locale, {
                                  style: "currency",
                                  currency: "USD",
                                  currencyDisplay: "narrowSymbol",
                                }).format(r.cost.amount)
                              : r.cost.amount.toLocaleString(locale)
                            : "—"}
                        </span>
                      ),
                    },
                    { key: "result", header: t("Result"), cell: (r) => <RunResult run={r} /> },
                    {
                      key: "open",
                      header: <span className="sr-only">{t("Open")}</span>,
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
            <AlertDialogTitle>{t("Delete {{name}}?", { name: routine.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "It stops running. It waits 30 days in Settings › Export and deletion with its run history, and comes back paused if you restore it.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={onDelete}>
              {t("Delete routine")}
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
