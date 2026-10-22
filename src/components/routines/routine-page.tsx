import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { EmptyPage } from "@/components/empty-page";
import { RoutineDetail } from "@/components/routines/routine-detail";
import { api, ApiError } from "@/lib/api-client";
import type { UpdateRoutineInput } from "@/lib/routines-api";
import {
  useRoutines,
  useRoutineRuns,
  useUpdateRoutine,
  useDeleteRoutine,
  useRunRoutine,
  useDeliveryChannels,
} from "@/hooks/use-routines";
import { useConnections } from "@/hooks/use-connections";
import { useAgentsStore } from "@/lib/agents-store";

/**
 * One routine, with what can be done to it: the body both `/routines/:id`
 * and an agent's Routines tab show. Each page brings its own frame and its
 * own way back.
 */
export function RoutinePage({
  routineId,
  notFoundAction,
  onDeleted,
}: {
  routineId: string;
  /** The way back when the routine is not there. */
  notFoundAction: ReactNode;
  /** Where to go once it is deleted. */
  onDeleted: () => void;
}) {
  const { data: routines = [], isLoading } = useRoutines();
  const { data: runs = [] } = useRoutineRuns(routineId);
  const { data: channels = [] } = useDeliveryChannels();
  // Only so a routine watching one can be named by the account rather than by
  // its id. Workspace-visible, so this resolves for a teammate reading a shared
  // routine too — unlike the delivery channel below it.
  const { data: connectionData } = useConnections();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  // Already in the cache — the app shell loads both. The bundles are for the
  // output picker; the agents are only so the card can say whether this
  // routine's agent also reads the bundle it writes to.
  const { bundles, agents, canWrite } = useAgentsStore();
  const updateRoutine = useUpdateRoutine();
  const deleteRoutine = useDeleteRoutine();
  const runRoutine = useRunRoutine();

  const routine = routines.find((r) => r.id === routineId);

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;

  if (!routine) {
    return (
      <EmptyPage
        title="Routine not found"
        description="It may have been deleted, or the link points at another workspace."
        actions={notFoundAction}
      />
    );
  }

  const isOwner = routine.userId === me?.user.id;
  // Channels are RLS-scoped to their owner, so these resolve only for our own.
  const delivering = channels.filter(
    (c) => c.id === routine.deliveryChannelId || routine.channelIds.includes(c.id),
  );
  const channelLabels = isOwner
    ? {
        email: delivering.filter((c) => c.kind === "email").map((c) => c.label),
        slack: delivering.filter((c) => c.kind !== "email").map((c) => c.label),
      }
    : null;

  const togglePause = async () => {
    const next = routine.status === "active" ? "paused" : "active";
    try {
      await updateRoutine.mutateAsync({ id: routine.id, patch: { status: next } });
      // Resuming also clears consecutive_failures and fires promptly, which is
      // why a routine the engine auto-paused recovers with one click.
      toast.success(next === "active" ? "Routine resumed" : "Routine paused");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update that routine");
    }
  };

  const save = async (patch: UpdateRoutineInput) => {
    try {
      await updateRoutine.mutateAsync({ id: routine.id, patch });
      toast.success("Routine updated");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update that routine");
    }
  };

  const runNow = async () => {
    try {
      const result = await runRoutine.mutateAsync(routine.id);
      if (result.status === "ok") {
        if (result.itemsNew > 0) {
          toast.success(
            `Delivered · ${result.itemsNew} new item${result.itemsNew === 1 ? "" : "s"}`,
          );
        } else {
          toast.success("Routine executed and delivered");
        }
      } else if (result.status === "skipped") {
        toast.message("No action needed");
      } else if (result.status === "waiting") {
        toast.message("The browser is working — the report is sent when it answers");
      } else {
        toast.error("That run failed — see the run history for why");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not run that routine");
    }
  };

  const remove = async () => {
    try {
      await deleteRoutine.mutateAsync(routine.id);
      toast.success("Routine deleted");
      onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete that routine");
    }
  };

  return (
    <RoutineDetail
      routine={routine}
      runs={runs}
      connections={connectionData?.connections ?? []}
      bundles={bundles}
      attachedBundleIds={agents.find((a) => a.id === routine.agentId)?.bundleIds ?? []}
      canWrite={canWrite}
      onSave={(patch) => void save(patch)}
      agent={agents.find((a) => a.id === routine.agentId)}
      createdByName={routine.ownerName}
      runningSince={routine.runningSince}
      channelLabels={channelLabels}
      isOwner={isOwner}
      onTogglePause={() => void togglePause()}
      onDelete={() => void remove()}
      onToggleShared={(shared) => void save({ visibility: shared ? "shared" : "private" })}
      onRunNow={() => void runNow()}
      running={runRoutine.isPending}
      busy={updateRoutine.isPending || deleteRoutine.isPending}
      editHref={isOwner ? `/routines/${routine.id}/edit` : undefined}
    />
  );
}
