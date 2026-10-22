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

/** The line under a routine's name: what it is doing, or what it did, or when it next will. */
export function routineLine(r: RoutineListItem, now: number = Date.now()): string {
  if (r.runningSince) return "Running now";
  if (r.status === "completed") return "Finished its series";
  if (r.status === "paused") {
    if (r.pausedByName && r.pausedAt)
      return `Paused by ${r.pausedByName} · ${formatRelative(r.pausedAt, now)}`;
    return r.pausedReason ? `Paused: ${r.pausedReason}` : "Paused";
  }
  if (r.lastRun) {
    const how =
      r.lastRun.status === "ok" ? "Done" : r.lastRun.status === "failed" ? "Failed" : "Skipped";
    return `Last run ${lastActivityWords(r.lastRun.at, now)} · ${how}`;
  }
  if (r.nextRunAt) return `Next run ${formatRelative(r.nextRunAt, now)}`;
  return "Not run yet";
}

/** The list's footer (A7): "14 runs in the last 7 days · 13 done, 1 failed · 118 credits". */
export function statsLine(s: {
  runs: number;
  done: number;
  failed: number;
  cost: number;
  unit: string;
}): string {
  if (s.runs === 0) return "No runs in the last 7 days";
  const parts = [
    `${s.runs} run${s.runs === 1 ? "" : "s"} in the last 7 days`,
    `${s.done} done, ${s.failed} failed`,
  ];
  if (s.cost > 0)
    parts.push(
      s.unit === "credits" ? `${s.cost.toLocaleString("en-US")} credits` : `$${s.cost.toFixed(2)}`,
    );
  return parts.join(" · ");
}
