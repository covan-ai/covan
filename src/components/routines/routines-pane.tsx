import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import type { RoutineListItem } from "@/lib/routines-api";
import { useAgentsStore } from "@/lib/agents-store";
import { cronToShort } from "@/lib/cron-to-prose";
import { routineDot, routineLine, statsLine } from "@/lib/routine-state";
import { AgentMark } from "@/components/agent-mark";
import { StatusDot } from "@/components/status-dot";
import { Pills } from "@/components/pills";
import { cn } from "@/lib/utils";

type PaneFilter = "all" | "active" | "paused" | "failed";

/**
 * Routines as a list beside the one you are looking at (A7): a 340px pane,
 * filters, one item per routine with its agent, schedule, name and what it
 * last did, and the week's runs at the foot. Scoped to one agent on that
 * agent's Routines tab.
 */
export function RoutinesPane({
  agentId,
  selectedId,
  hrefFor,
  canCreate = true,
}: {
  agentId?: string;
  selectedId?: string;
  hrefFor: (routine: RoutineListItem) => string;
  /** The "+" to the editor (A28); off for a viewer. */
  canCreate?: boolean;
}) {
  const { agents } = useAgentsStore();
  const [filter, setFilter] = useState<PaneFilter>("all");
  const { data: routines = [], isPending } = useQuery({
    queryKey: ["routines"],
    queryFn: () => api.routines.list(),
  });
  const { data: stats } = useQuery({
    queryKey: ["routines", "stats", 7],
    queryFn: () => api.routines.stats(7),
  });
  const byId = new Map(agents.map((a) => [a.id, a]));
  const mine = routines.filter((r) => !agentId || r.agentId === agentId);
  const shown = mine.filter((r) =>
    filter === "all"
      ? true
      : filter === "active"
        ? r.status === "active"
        : filter === "paused"
          ? r.status !== "active"
          : r.lastRun?.status === "failed",
  );

  return (
    <section
      aria-label="Routines list"
      className="flex shrink-0 flex-col border-border bg-background max-lg:border-b lg:w-[340px] lg:border-r"
    >
      <div className="flex h-12 items-center gap-2 border-b border-border pr-3 pl-4">
        <h2 className="m-0 text-lead font-semibold">Routines</h2>
        <span className="text-meta text-muted-foreground">{mine.length}</span>
        {canCreate && (
          <Link
            to="/routines/new"
            search={agentId ? { agent: agentId } : {}}
            aria-label="New routine"
            data-coach="new-routine"
            className="ml-auto grid size-8 place-items-center rounded-md text-foreground hover:bg-surface"
          >
            <Plus className="size-4" strokeWidth={1.75} />
          </Link>
        )}
      </div>
      <div className="overflow-x-auto border-b border-hairline px-3 py-2">
        <Pills
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "paused", label: "Paused" },
            { value: "failed", label: "Failed" },
          ]}
          className="flex-nowrap"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto max-lg:max-h-72">
        {isPending ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {mine.length === 0 ? "No routines yet." : "None here."}
          </p>
        ) : (
          shown.map((r) => {
            const agent = byId.get(r.agentId);
            return (
              <Link
                key={r.id}
                to={hrefFor(r)}
                aria-current={r.id === selectedId ? "page" : undefined}
                className={cn(
                  "flex items-start gap-2.5 border-b border-hairline px-4 py-3",
                  r.id === selectedId ? "bg-surface-muted" : "hover:bg-surface-muted",
                )}
              >
                <AgentMark agent={agent ?? { name: "Agent" }} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{agent?.name ?? "Agent"}</span>
                    <span className="ml-auto truncate whitespace-nowrap">
                      {r.triggerKind === "schedule" || r.triggerKind === "both"
                        ? cronToShort(r.scheduleCron)
                        : r.triggerKind === "event"
                          ? "On an app event"
                          : "On a webhook"}
                    </span>
                  </span>
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                    {routineLine(r)}
                  </span>
                </span>
                <StatusDot state={routineDot(r)} className="mt-1.5" />
              </Link>
            );
          })
        )}
      </div>
      {stats && (
        <div className="border-t border-hairline px-4 py-3 text-xs leading-normal text-micro-foreground">
          {statsLine(stats)}
        </div>
      )}
    </section>
  );
}
