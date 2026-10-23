import { englishT, type Translate } from "@/i18n";
import type { RoutineListItem } from "@/lib/routines-api";
import type { DotState } from "@/lib/dot-states";
import { formatRelative } from "@/lib/relative-time";
import { lastActivityWords } from "@/lib/day-groups";

/** A routine's dot (A7): running, failed last time, done, or idle (paused or not run yet). */
export function routineDot(r: RoutineListItem): DotState {
  if (r.runningSince) return "running";
  if (r.status !== "active") return "idle";
  if (r.lastRun?.status === "failed") return "failed";
  if (r.lastRun?.status === "ok") return "done";
  return "idle";
}

/**
 * The line under a routine's name: what it is doing, or what it did, or when
 * it next will. `t` and `locale` come after `now` and default to the English;
 * `locale` is left undefined so each date helper keeps its own default.
 */
export function routineLine(
  r: RoutineListItem,
  now: number = Date.now(),
  t: Translate = englishT,
  locale?: string,
): string {
  if (r.runningSince) return t("Running now");
  if (r.status === "completed") return t("Finished its series");
  if (r.status === "paused") {
    if (r.pausedByName && r.pausedAt) {
      return t("Paused by {{name}} · {{when}}", {
        name: r.pausedByName,
        when: formatRelative(r.pausedAt, now, t, locale),
      });
    }
    return r.pausedReason ? t("Paused: {{reason}}", { reason: r.pausedReason }) : t("Paused");
  }
  if (r.lastRun) {
    const how =
      r.lastRun.status === "ok"
        ? t("Done", { context: "status", defaultValue: "Done" })
        : r.lastRun.status === "failed"
          ? t("Failed")
          : t("Skipped");
    return t("Last run {{when}} · {{how}}", {
      when: lastActivityWords(r.lastRun.at, now, t, locale),
      how,
    });
  }
  if (r.nextRunAt)
    return t("Next run {{when}}", { when: formatRelative(r.nextRunAt, now, t, locale) });
  return t("Not run yet");
}

/** The list's footer (A7): "14 runs in the last 7 days · 13 done, 1 failed · 118 credits". */
export function statsLine(
  s: {
    runs: number;
    done: number;
    failed: number;
    cost: number;
    unit: string;
  },
  t: Translate = englishT,
  locale: string = "en-US",
): string {
  if (s.runs === 0) return t("No runs in the last 7 days");
  const parts = [
    t("{{count}} run in the last 7 days", {
      count: s.runs,
      defaultValue_other: "{{count}} runs in the last 7 days",
    }),
    t("{{done}} done, {{failed}} failed", { done: s.done, failed: s.failed }),
  ];
  if (s.cost > 0) {
    parts.push(
      s.unit === "credits"
        ? t("{{amount}} credit", {
            count: s.cost,
            amount: s.cost.toLocaleString(locale),
            defaultValue_other: "{{amount}} credits",
          })
        : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(s.cost),
    );
  }
  return parts.join(" · ");
}
