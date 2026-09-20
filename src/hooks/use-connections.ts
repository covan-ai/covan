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

export const toolConnectionsKey = ["tool-connections"] as const;

/**
 * The services an agent can call, and what this build can do with them.
 *
 * A separate query from `useConnections` rather than a field on it, because
 * the two answer different questions and one of them is about to be asked
 * from a second screen: an agent's settings will want to say which services
 * it can reach, and that page has no business fetching the document sources
 * as well.
 */
export function useToolConnections() {
  return useQuery({ queryKey: toolConnectionsKey, queryFn: () => api.toolConnections.list() });
}

export function useCreateToolConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.toolConnections.create>[0]) =>
      api.toolConnections.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
  });
}

export function useUpdateToolConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Parameters<typeof api.toolConnections.update>[1];
    }) => api.toolConnections.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
  });
}

export function useRemoveToolConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.toolConnections.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
  });
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

/**
 * Replace the grant on a connection that already exists.
 *
 * Same navigation as `useStartConnection`, and same reason. What differs is
 * where the browser comes back to: the callback updates the row rather than
 * inserting one, so the page reloads with one connection whose account has
 * changed rather than with two pointed at the same bundle.
 */
export function useReconnectConnection() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { url } = await api.connections.reconnect(id);
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
