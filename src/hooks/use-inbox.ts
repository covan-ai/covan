import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InboxFilter } from "@/lib/api-client";

/**
 * The Inbox and the counts beside it in the sidebar and the palette (B2).
 *
 * The counts are polled every thirty seconds while the app is in view — and
 * not in a background tab, which is TanStack's default for an interval — and
 * that poll is also what "away for an hour" is measured against (0133).
 */
export function useInboxCounts() {
  return useQuery({
    queryKey: ["inbox", "counts"],
    queryFn: () => api.inbox.counts(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useInbox(filter: InboxFilter, agentId?: string) {
  return useQuery({
    queryKey: ["inbox", "list", filter, agentId ?? null],
    queryFn: () => api.inbox.list({ filter, agentId }),
    refetchInterval: 30_000,
  });
}

/** Opening a thread reads it: the row and the counts drop it at once. */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.inbox.markRead(sessionId),
    onMutate: async (sessionId) => {
      queryClient.setQueriesData<{
        items: Array<{ sessionId: string; unread: boolean; unreadCount: number }>;
      }>(
        { queryKey: ["inbox", "list"] },
        (page) =>
          page && {
            ...page,
            items: page.items.map((i) =>
              i.sessionId === sessionId ? { ...i, unread: false, unreadCount: 0 } : i,
            ),
          },
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.inbox.markAllRead(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
}
