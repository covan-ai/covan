import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { CreateRoutineInput, UpdateRoutineInput } from "@/lib/routines-api";

// Routines are needed on three screens, so they are fetched here rather than
// added to agents-store.tsx, which every authed page pays to load. The settings
// route already sets this precedent by calling useQuery with api.* directly.

export const routinesKey = ["routines"] as const;
export const channelsKey = ["delivery-channels"] as const;
export const runsKey = (routineId: string) => ["routine-runs", routineId] as const;

export function useRoutines() {
  return useQuery({ queryKey: routinesKey, queryFn: () => api.routines.list() });
}

export function useRoutineRuns(routineId: string) {
  return useQuery({ queryKey: runsKey(routineId), queryFn: () => api.routines.runs(routineId) });
}

export function useDeliveryChannels() {
  return useQuery({ queryKey: channelsKey, queryFn: () => api.deliveryChannels.list() });
}

export function useCreateRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => api.routines.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: routinesKey }),
  });
}

export function useUpdateRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRoutineInput }) =>
      api.routines.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: routinesKey }),
  });
}

export function useRunRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.routines.run(id),
    // A manual run writes a routine_runs row and moves next_run_at, so both the
    // history and the routine itself are stale the moment this resolves.
    onSuccess: (_result, id) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: runsKey(id) }),
        qc.invalidateQueries({ queryKey: routinesKey }),
      ]),
  });
}

export function useDeleteRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.routines.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: routinesKey }),
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: "slack_webhook" | "email"; secret: string }) =>
      api.deliveryChannels.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: channelsKey }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deliveryChannels.remove(id),
    // A channel delete can free a routine's constraint, so both lists refresh.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: channelsKey }),
        qc.invalidateQueries({ queryKey: routinesKey }),
      ]),
  });
}
