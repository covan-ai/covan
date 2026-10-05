import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export const composioToolkitsKey = (search: string, category: string) =>
  ["composio-toolkits", search, category] as const;
export const composioCategoriesKey = ["composio-categories"] as const;
export const composioGrantsKey = ["composio-grants"] as const;

/**
 * The catalogue, a page at a time.
 *
 * The only `useInfiniteQuery` in the application, and it earns the exception:
 * Composio pages with an opaque cursor, the grid has a "Show more" under it,
 * and the alternative is accumulating pages in component state and getting
 * the reset-on-filter-change wrong. Changing the search or the category
 * changes the key, which starts a new list rather than appending to the old
 * one — which is the bug the hand-rolled version would have.
 *
 * `enabled` rather than an unconditional query: every call is a round trip to
 * a third party against a rate limit the deployment shares, and nothing needs
 * the catalogue until somebody opens it.
 */
export function useComposioToolkits(search: string, category: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: composioToolkitsKey(search, category),
    queryFn: ({ pageParam }) =>
      api.composio.toolkits({ search, category, cursor: pageParam as string }),
    initialPageParam: "",
    // "" is the catalogue saying there is no more, and it has to be mapped to
    // undefined or the button offers a page that comes back identical.
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled,
  });
}

/**
 * The catalogue's own headings.
 *
 * Read once and cached hard: this is a taxonomy, not state. Re-asking on
 * every mount would be a request to a third party for a list that changes
 * about never.
 */
export function useComposioCategories(enabled: boolean) {
  return useQuery({
    queryKey: composioCategoriesKey,
    queryFn: () => api.composio.categories(),
    staleTime: 60 * 60 * 1000,
    enabled,
  });
}

export const composioToolkitDetailKey = (slug: string) =>
  ["composio-toolkit-detail", slug] as const;

/**
 * One application, read when somebody opens its card.
 *
 * Named in the singular and spelled differently from `composioToolkitsKey` on
 * purpose — two keys one character apart is a real hazard at a call site, and
 * these answer different questions.
 *
 * Cached for an hour, like the categories above and for the same reason: a
 * description and ten operation names are a taxonomy, not state, and ten
 * minutes stale is invisible. `gcTime` matches, because the case worth covering
 * is open, close, open again — with the five-minute default the entry is
 * evicted the moment no card is mounted and the hour would never be reached.
 *
 * Deliberately no server-side cache behind this. `lib/composio/client.ts`
 * refuses one and says why: a cache would be a second place for "which
 * application is this" to be wrong. That argument is about the write path and
 * this is the read one, but it is still the first cache on that path and the
 * client one already collapses the only case with any volume.
 */
export function useComposioToolkitDetail(slug: string | null) {
  return useQuery({
    queryKey: composioToolkitDetailKey(slug ?? ""),
    queryFn: () => api.composio.toolkit(slug as string),
    enabled: Boolean(slug),
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
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
    mutationFn: async (input: { toolkit: string; label?: string; expectRedirect?: boolean }) => {
      const { expectRedirect = true, ...body } = input;
      const { url } = await api.composio.connect(body);
      await queryClient.invalidateQueries({ queryKey: toolConnectionsKey });
      // An application that asks for no sign-in comes back with no address to
      // send anybody to, and that is the whole flow: the row is already there
      // and `useComposioStatus` settles it. Navigating to "" would reload the
      // page onto itself and look like the connect button did nothing.
      //
      // `expectRedirect` is the caller's own reading of the catalogue and is
      // deliberately NOT sent to the worker, which re-derives everything it
      // needs: it exists only to decide whether an empty address here is the
      // flow working or a bug going quiet.
      //
      // Which is exactly why the other case must not reach here silently. A
      // sign-in flow with no address is a bug upstream, and this line is where
      // it would become invisible: the button would un-disable, nothing would
      // happen, and no error would fire so there would be no toast.
      if (url) window.location.assign(url);
      else if (expectRedirect) {
        throw new Error("That connection started but there is nowhere to finish it.");
      }
    },
  });
}

/**
 * How long the page keeps asking before it gives up — forty ticks of three
 * seconds, about two minutes.
 *
 * Not a tidiness limit. Every tick is one request to `/api`, which sits behind
 * a 120-a-minute budget keyed by IP, so an unbounded poll costs 20 of those a
 * minute **per unfinished connection**. Six of them and the whole product
 * starts answering 429 — chat, documents, everything — because somebody opened
 * six applications and went to find their keys. Each tick is also one request
 * to Composio against an allowance shared by every tool call on the
 * deployment.
 *
 * Two minutes is long enough for a consent screen, which is the flow that
 * finishes while the page watches. A credential typed into a provider's
 * dashboard takes longer than any poll should last, and that one is settled by
 * the worker instead — the status route fails a row that has been pending a
 * quarter of an hour.
 */
const MAX_STATUS_POLLS = 40;

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
    // Counted by the cache rather than by a counter of our own, which buys two
    // things a `useRef` would not: the count belongs to the connection, since
    // its id is in the key, and it survives the card unmounting and remounting
    // as the grid re-renders — a counter that reset with the component would be
    // no cap at all.
    refetchInterval: (query) =>
      pending && query.state.dataUpdateCount < MAX_STATUS_POLLS ? 3_000 : false,
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
