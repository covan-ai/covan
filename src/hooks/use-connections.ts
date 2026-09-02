import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ProviderId } from "@/lib/connections-api";

// The Integrations page is the only screen that reads any of this, so it lives
// here rather than in agents-store.tsx, which every authed page pays to load —
// the same reasoning use-routines.ts records.

export const connectionsKey = ["connections"] as const;
export const slackKey = ["slack"] as const;
export const connectionRunsKey = (id: string) => ["connection-runs", id] as const;

export function useConnections() {
  return useQuery({ queryKey: connectionsKey, queryFn: () => api.connections.list() });
}

export function useConnectionRuns(id: string, enabled = true) {
  return useQuery({
    queryKey: connectionRunsKey(id),
    queryFn: () => api.connections.runs(id),
    enabled,
  });
}

export function useSlack() {
  return useQuery({ queryKey: slackKey, queryFn: () => api.slack.get() });
}

/**
 * Start a grant and hand the browser to the provider.
 *
 * The navigation is deliberately a full page load rather than a popup. A popup
 * has to be opened synchronously to survive Safari's blocker, which would mean
 * opening it before the request that produces the URL — so it would flash a
 * blank window on every failure, including "this deployment has no Notion
 * client".
 */
export function useStartConnection() {
  return useMutation({
    mutationFn: async ({ provider, bundleId }: { provider: ProviderId; bundleId: string }) => {
      const { url } = await api.connections.start(provider, bundleId);
      window.location.assign(url);
    },
  });
}

export function useStartSlackInstall() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.slack.start();
      window.location.assign(url);
    },
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof api.connections.update>[1];
    }) => api.connections.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionsKey }),
  });
}

export function useSyncConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.connections.sync(id),
    // A manual sync writes documents and moves next_sync_at, so the connection
    // itself, its history and the bundle counts are all stale the moment this
    // resolves.
    onSuccess: (_outcome, id) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: connectionsKey }),
        qc.invalidateQueries({ queryKey: connectionRunsKey(id) }),
        qc.invalidateQueries({ queryKey: ["agents"] }),
      ]),
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, documents }: { id: string; documents: "keep" | "delete" }) =>
      api.connections.remove(id, documents),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: connectionsKey }),
        qc.invalidateQueries({ queryKey: ["agents"] }),
      ]),
  });
}

export function useSetSlackAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.slack.setAgent(agentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: slackKey }),
  });
}

export function useRemoveSlack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.slack.remove(),
    onSuccess: () => qc.invalidateQueries({ queryKey: slackKey }),
  });
}
