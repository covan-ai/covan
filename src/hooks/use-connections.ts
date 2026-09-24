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

export const composioToolkitsKey = (search: string) => ["composio-toolkits", search] as const;
export const composioGrantsKey = ["composio-grants"] as const;

/**
 * The catalogue, fetched only while somebody is looking at it.
 *
 * `enabled` rather than an unconditional query, for the reason
 * `useSupabaseProjects` is: every call is a round trip to a third party against
 * a rate limit the deployment shares, and nothing on the page needs the
 * catalogue until a person opens it.
 */
export function useComposioToolkits(search: string, enabled: boolean) {
  return useQuery({
    queryKey: composioToolkitsKey(search),
    queryFn: () => api.composio.toolkits(search),
    enabled,
  });
}

/**
 * Start a consent flow and hand the browser to Composio.
 *
 * A full page load rather than a popup, and `useStartConnection`'s reason
 * applies unchanged: a popup has to be opened synchronously to survive Safari's
 * blocker, which would mean opening it before the request that produces the
 * URL — so it would flash a blank window on every failure, including "this
 * deployment has no Composio key".
 *
 * The row is invalidated first, because it exists before the navigation: a
 * person who comes back having abandoned the consent screen should find a
 * connection that says it is unfinished rather than nothing at all.
 */
export function useConnectComposio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { toolkit: string; label?: string }) => {
      const { url } = await api.composio.connect(input);
      await queryClient.invalidateQueries({ queryKey: toolConnectionsKey });
      window.location.assign(url);
    },
  });
}

/**
 * Ask whether a consent flow has finished.
 *
 * Polled by the card while a row is `pending`, and stopped the moment it is
 * not: the worker settles the row on the first answer that is not pending, so
 * asking again would be a request to a third party for something that cannot
 * change.
 */
export function useComposioStatus(id: string | null, pending: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["composio-status", id],
    queryFn: async () => {
      const answer = await api.composio.status(id as string);
      if (answer.status !== "pending") {
        await queryClient.invalidateQueries({ queryKey: toolConnectionsKey });
      }
      return answer;
    },
    enabled: Boolean(id) && pending,
    refetchInterval: pending ? 3_000 : false,
  });
}

export function useComposioGrants(agentId?: string) {
  return useQuery({
    queryKey: [...composioGrantsKey, agentId ?? "all"],
    queryFn: () => api.composio.grants(agentId),
  });
}

export function useSetComposioGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.composio.setGrant>[0]) =>
      api.composio.setGrant(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: composioGrantsKey }),
  });
}

export function useRemoveComposioGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.composio.removeGrant>[0]) =>
      api.composio.removeGrant(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: composioGrantsKey }),
  });
}

export const supabaseAccountKey = ["supabase-account"] as const;

/**
 * The Supabase account this workspace has connected, if any.
 *
 * Its own query rather than a field on `useToolConnections`, for the same
 * reason that one is separate: the projects it opened are ordinary tool
 * connections and are already in that list, and a screen that wants only the
 * services has no business asking whether an account exists.
 */
export function useSupabaseAccount() {
  return useQuery({ queryKey: supabaseAccountKey, queryFn: () => api.supabaseAccount.get() });
}

/**
 * Paste a token, or replace the one already stored.
 *
 * Both invalidations are needed and they are not the same one: replacing a
 * token changes the account, and disconnecting it later will take the
 * connected projects with it, so the list that shows them cannot be trusted
 * to be current either.
 */
export function useConnectSupabaseAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.supabaseAccount.connect>[0]) =>
      api.supabaseAccount.connect(input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: supabaseAccountKey }),
        queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
      ]),
  });
}

export const supabaseProjectsKey = ["supabase-projects"] as const;

/**
 * The projects the connected account can see, fetched only when somebody is
 * looking at the picker.
 *
 * `enabled` rather than an unconditional query because this one costs a round
 * trip to Supabase on every call, against a rate limit the workspace shares.
 * Nothing on the page needs it until a person presses "add a project".
 */
export function useSupabaseProjects(enabled: boolean) {
  return useQuery({
    queryKey: supabaseProjectsKey,
    queryFn: () => api.supabaseAccount.projects(),
    enabled,
  });
}

export function useAddSupabaseProjects() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.supabaseAccount.addProjects>[0]) =>
      api.supabaseAccount.addProjects(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
  });
}

export function useDisconnectSupabaseAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.supabaseAccount.remove(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: supabaseAccountKey }),
        queryClient.invalidateQueries({ queryKey: toolConnectionsKey }),
      ]),
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
