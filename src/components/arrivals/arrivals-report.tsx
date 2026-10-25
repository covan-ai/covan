import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { lookup, useTranslation, type Translate } from "@/i18n";
import { api } from "@/lib/api-client";
import {
  KIND_NAME,
  UNANSWERED_KINDS,
  type ArrivalBucket,
  type ArrivalKind,
  type ArrivalScan,
} from "@/lib/arrivals";
import { arrivalTemplateById, fillTemplate } from "@/lib/routine-templates";
import { channelsKey, routinesKey } from "@/hooks/use-routines";
import { StatCard } from "@/components/stat-card";
import { StatusDot } from "@/components/status-dot";
import { Disclosure } from "@/components/disclosure";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/** How many proposals start switched on: enough to matter, few enough to read. */
const ON_BY_DEFAULT = 3;

/** The worker's mask for an email channel's label (`maskSecret`), to find one already made. */
function maskedEmail(address: string): string {
  const [local, domain] = address.split("@");
  const shown = local.length <= 2 ? local : `${local[0]}…${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

function bucketName(t: Translate, bucket: ArrivalBucket): string {
  return bucket.label || lookup(t, KIND_NAME[bucket.kind]);
}

/**
 * Makes one routine per picked proposal, in the report's order.
 *
 * Every digest goes to the Covan inbox and to the person's own address (the
 * owner's decision, spec "Proposals"): the first routine is created with the
 * address, which makes the channel — or with a confirmed channel the person
 * already has at that address — and every later one reuses that channel, so
 * one press makes one channel at most. Each routine is written back to its
 * bucket as soon as it exists, and a bucket that has one is skipped, so a
 * second press, or a press after a half-way failure, makes nothing twice.
 */
export async function turnOn(input: {
  scan: ArrivalScan;
  picked: ArrivalKind[];
  agentId: string;
  email: string;
  timezone: string;
  t: Translate;
}): Promise<{ created: number; failed: boolean }> {
  const { scan, picked, agentId, email, timezone, t } = input;
  const todo = scan.buckets.filter((b) => picked.includes(b.kind) && b.templateId && !b.routineId);
  if (todo.length === 0) return { created: 0, failed: false };

  let created = 0;
  try {
    const channels = await api.deliveryChannels.list().catch(() => []);
    let channelId = channels.find(
      (c) => c.kind === "email" && c.confirmed && c.label === maskedEmail(email),
    )?.id;
    for (const bucket of todo) {
      const template = arrivalTemplateById(bucket.templateId!);
      if (!template) continue;
      const draft = fillTemplate(template, bucketName(t, bucket));
      const routine = await api.routines.create({
        agentId,
        name: lookup(t, draft.name),
        sourceKind: "none",
        instruction: draft.instruction,
        scheduleCron: draft.scheduleCron,
        timezone,
        deliverInbox: true,
        ...(channelId ? { deliveryChannelId: channelId } : { deliveryEmail: email }),
      });
      channelId = routine.deliveryChannelId;
      await api.arrivals.setRoutine(scan.id, bucket.kind, routine.id);
      created += 1;
    }
    return { created, failed: false };
  } catch {
    return { created, failed: true };
  }
}

/**
 * What arrived in the last thirty days, and what to do about it (spec: "What
 * the person sees"). One component for the welcome step and the `/arrivals`
 * page: the parent supplies the heading and polls while the scan runs.
 */
export function ArrivalsReport({
  scan,
  agentId,
  email,
  onDone,
  onRetry,
  onSkip,
}: {
  scan: ArrivalScan;
  agentId: string;
  email: string;
  /** After "Turn these on", with how many routines were made. */
  onDone: (created: number) => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proposals = scan.buckets.filter((b) => b.templateId && !b.routineId);
  const [picked, setPicked] = useState<Set<ArrivalKind>>(
    () => new Set(proposals.slice(0, ON_BY_DEFAULT).map((b) => b.kind)),
  );
  const [busy, setBusy] = useState(false);

  if (scan.status === "queued" || scan.status === "running") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <StatusDot state="running" />
        {t("Reading your last thirty days…")}
      </p>
    );
  }

  if (scan.status === "failed") {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm">
          <StatusDot state="failed" />
          {t("Covan could not read your mailbox this time.")}
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
              defaultValue_other: "{{count}} routines are on; the rest could not be made. Try again.",
            })
          : t("The routines could not be made. Try again."),
      );
      return;
    }
    if (created > 0) {
      toast.success(
        t("{{count}} routine is on.", { count: created, defaultValue_other: "{{count}} routines are on." }),
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
