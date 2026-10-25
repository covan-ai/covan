import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { lookup, useTranslation } from "@/i18n";
import { KIND_NAME, UNANSWERED_KINDS, type ArrivalKind, type ArrivalScan } from "@/lib/arrivals";
import { channelsKey, routinesKey } from "@/hooks/use-routines";
import { StatCard } from "@/components/stat-card";
import { StatusDot } from "@/components/status-dot";
import { Disclosure } from "@/components/disclosure";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { arrivalTemplateById } from "@/lib/routine-templates";
import { bucketName, turnOn } from "./turn-on";

/** How many proposals start switched on: enough to matter, few enough to read. */
const ON_BY_DEFAULT = 3;

type ReportProps = {
  scan: ArrivalScan;
  agentId: string;
  email: string;
  /** After "Turn these on", with how many routines were made. */
  onDone: (created: number) => void;
  onRetry: () => void;
  onSkip: () => void;
};

/**
 * What arrived in the last thirty days, and what to do about it (spec: "What
 * the person sees"). One component for the welcome step and the `/arrivals`
 * page: the parent supplies the heading and polls while the scan runs.
 *
 * Keyed by the scan and its status, so a report that mounted while the scan
 * was reading starts again, with its first proposals switched on, when the
 * scan finishes in place.
 */
export function ArrivalsReport(props: ReportProps) {
  return <Report key={`${props.scan.id}:${props.scan.status}`} {...props} />;
}

/** A failure in words, and where its fix is (0139's `reason`). */
function Failure({ reason }: { reason: ArrivalScan["reason"] }) {
  const { t } = useTranslation();
  if (reason === "no_credit") {
    return (
      <>
        {t(
          "This workspace has no credits left for a scan. A workspace admin can add more, and then it can run again.",
        )}
      </>
    );
  }
  if (reason === "source" || reason === "no_source") {
    return (
      <>
        {t("Covan could not read your mailbox. Connect it again, then try again.")}{" "}
        <Link to="/settings/integrations" className="underline underline-offset-2">
          {t("Open Integrations")}
        </Link>
      </>
    );
  }
  return <>{t("Covan could not read your mailbox this time.")}</>;
}

function Report({ scan, agentId, email, onDone, onRetry, onSkip }: ReportProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proposals = scan.buckets.filter((b) => b.templateId && !b.routineId);
  const [picked, setPicked] = useState<Set<ArrivalKind>>(
    () => new Set(proposals.slice(0, ON_BY_DEFAULT).map((b) => b.kind)),
  );
  const [busy, setBusy] = useState(false);

  if (scan.status === "queued" || scan.status === "running") {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <StatusDot state="running" />
          {t("Reading your last thirty days…")}
        </p>
        <Button variant="secondary" onClick={onSkip}>
          {t("Not now")}
        </Button>
      </div>
    );
  }

  if (scan.status === "failed") {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm">
          <StatusDot state="failed" />
          <span>
            <Failure reason={scan.reason} />
          </span>
        </p>
        <div className="flex gap-2">
          <Button onClick={onRetry}>{t("Try again")}</Button>
          <Button variant="secondary" onClick={onSkip}>
            {t("Continue without this")}
          </Button>
        </div>
      </div>
    );
  }

  if (!scan.total) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("Nothing arrived in the last thirty days that Covan could read.")}
        </p>
        <Button variant="secondary" onClick={onSkip}>
          {t("Continue")}
        </Button>
      </div>
    );
  }

  const press = async () => {
    setBusy(true);
    const { created, failed } = await turnOn({
      scan,
      picked: [...picked],
      agentId,
      email,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      t,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: routinesKey }),
      queryClient.invalidateQueries({ queryKey: channelsKey }),
      queryClient.invalidateQueries({ queryKey: ["arrivals"] }),
    ]);
    setBusy(false);
    if (failed) {
      toast.error(
        created > 0
          ? t("{{count}} routine is on; the rest could not be made. Try again.", {
              count: created,
              defaultValue_other:
                "{{count}} routines are on; the rest could not be made. Try again.",
            })
          : t("The routines could not be made. Try again."),
      );
      return;
    }
    if (created > 0) {
      toast.success(
        t("{{count}} routine is on.", {
          count: created,
          defaultValue_other: "{{count}} routines are on.",
        }),
      );
    }
    onDone(created);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          label={t("What arrived")}
          value={scan.total}
          detail={t("threads and meetings, last thirty days")}
        />
        <StatCard
          label={t("Never got a reply")}
          value={scan.unanswered ?? 0}
          detail={t("questions and requests, waiting over two days")}
        />
      </div>

      <ul className="border-t border-hairline">
        {scan.buckets.map((bucket) => (
          <li key={bucket.kind} className="border-b border-hairline px-1 py-2.5">
            <div className="flex min-h-8 items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{bucketName(t, bucket)}</span>
                <span className="block truncate text-meta text-muted-foreground">
                  {bucket.label ? `${lookup(t, KIND_NAME[bucket.kind])} · ` : ""}
                  {UNANSWERED_KINDS.has(bucket.kind)
                    ? t("{{count}} arrived · {{waiting}} never got a reply", {
                        count: bucket.count,
                        waiting: bucket.unanswered,
                      })
                    : t("{{count}} arrived", { count: bucket.count })}
                </span>
              </span>
              {bucket.routineId ? (
                <Link
                  to="/routines/$routineId"
                  params={{ routineId: bucket.routineId }}
                  className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground hover:text-foreground"
                >
                  <StatusDot state="done" />
                  {t("On")}
                </Link>
              ) : bucket.templateId ? (
                <Switch
                  checked={picked.has(bucket.kind)}
                  aria-label={t("Morning digest for {{name}}", { name: bucketName(t, bucket) })}
                  onCheckedChange={(on) =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (on) next.add(bucket.kind);
                      else next.delete(bucket.kind);
                      return next;
                    })
                  }
                />
              ) : null}
            </div>
            <p className="m-0 mt-0.5 text-meta text-muted-foreground">
              {bucket.templateId
                ? lookup(t, arrivalTemplateById(bucket.templateId)?.blurb ?? "")
                : t("Nothing to do here. About {{count}} a week you can ignore.", {
                    count: Math.round((bucket.count / scan.windowDays) * 7),
                  })}
            </p>
            {bucket.examples.length > 0 && (
              <Disclosure label={t("Examples")} className="mt-1">
                <ul className="mt-1 space-y-0.5 pl-4 text-meta text-muted-foreground">
                  {bucket.examples.map((subject) => (
                    <li key={subject} className="truncate">
                      {subject}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </li>
        ))}
      </ul>

      {proposals.length > 0 && (
        <p className="text-meta text-muted-foreground">
          {t("Each morning's digest lands in your Covan inbox and at {{email}}.", { email })}
        </p>
      )}

      <div className="flex gap-2">
        {proposals.length > 0 && (
          <Button onClick={() => void press()} disabled={busy || picked.size === 0}>
            {t("Turn these on")}
          </Button>
        )}
        <Button variant="secondary" onClick={onSkip} disabled={busy}>
          {proposals.length > 0 ? t("Not now") : t("Continue")}
        </Button>
      </div>
    </div>
  );
}
