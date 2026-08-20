import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { PageContainer } from "@/components/page-container";
import { EmptyState } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { RoutineDetail } from "@/components/routines/routine-detail";
import { EditRoutineDialog } from "@/components/routines/edit-routine-dialog";
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

export const Route = createFileRoute("/_authed/agents/$agentId/routines/$routineId")({
  component: RoutineDetailPage,
});

function RoutineDetailPage() {
  const { agentId, routineId } = Route.useParams();
  const navigate = useNavigate();
  const { data: routines = [], isLoading } = useRoutines();
  const { data: runs = [] } = useRoutineRuns(routineId);
  const { data: channels = [] } = useDeliveryChannels();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const updateRoutine = useUpdateRoutine();
  const deleteRoutine = useDeleteRoutine();
  const runRoutine = useRunRoutine();

  const routine = routines.find((r) => r.id === routineId);

  if (isLoading) {
    return (
      <PageContainer width="list">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </PageContainer>
    );
  }

  if (!routine) {
    return (
      <PageContainer width="list">
        <EmptyState
          title="Routine not found"
          description="It may have been deleted, or the link points at another workspace."
          action={
            <Button asChild variant="outline">
              <Link to="/agents/$agentId/routines" params={{ agentId }}>
                Back to routines
              </Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const isOwner = routine.userId === me?.user.id;
  // Channels are RLS-scoped to their owner, so this resolves only for our own.
  const channelLabel = channels.find((c) => c.id === routine.deliveryChannelId)?.label ?? null;

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
        toast.success(`Sent ${result.itemsNew} new item${result.itemsNew === 1 ? "" : "s"}`);
      } else if (result.status === "skipped") {
        // Not a failure. On a healthy feed with nothing new it is the common
        // case, and on a source-watching routine's first run it is expected.
        toast.message("Nothing new to send");
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
      void navigate({ to: "/agents/$agentId/routines", params: { agentId } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not delete that routine");
    }
  };

  return (
    <PageContainer width="list">
      <Link
        to="/agents/$agentId/routines"
        params={{ agentId }}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Routines
      </Link>
      <div className="mt-4">
        <RoutineDetail
          routine={routine}
          runs={runs}
          channelLabel={isOwner ? channelLabel : null}
          isOwner={isOwner}
          onTogglePause={() => void togglePause()}
          onDelete={() => void remove()}
          onToggleShared={(shared) => void save({ visibility: shared ? "shared" : "private" })}
          onRunNow={() => void runNow()}
          running={runRoutine.isPending}
          busy={updateRoutine.isPending || deleteRoutine.isPending}
          editAction={
            isOwner ? (
              <EditRoutineDialog
                routine={routine}
                channels={channels}
                onSave={(patch) => void save(patch)}
                saving={updateRoutine.isPending}
              />
            ) : null
          }
        />
      </div>
    </PageContainer>
  );
}
