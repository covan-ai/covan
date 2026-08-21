import type { QueryClient } from "@tanstack/react-query";

/**
 * Every cached query whose answer depends on which workspace is active.
 *
 * The app binds to one workspace at a time and the server resolves it from the
 * session, so nothing in these query keys names the workspace — which means
 * React Query cannot tell that changing workspaces invalidated all of them. The
 * list has to be written down somewhere, and this is that place.
 *
 * It was written down twice before this file, in the switcher and the create
 * flow, identically. `ideas` was missing from both: brainstorm ideas are
 * workspace-scoped like everything else here, so after switching, the ideas
 * panel kept showing the previous workspace's until something else evicted it.
 * Two hand-maintained copies is how that happens, which is the argument for one.
 *
 * Over-invalidating costs a refetch. Under-invalidating shows one workspace's
 * content under another workspace's name, so when in doubt, add the key.
 */
export const WORKSPACE_SCOPED_QUERY_KEYS = [
  "me",
  "workspaces",
  "agents",
  "bundles",
  "sessions",
  "messages",
  "ideas",
  "usage",
  "favorites",
  "invitations",
] as const;

/** Refetch everything that belongs to a workspace. Resolves when all have. */
export function invalidateWorkspaceScoped(queryClient: QueryClient): Promise<unknown> {
  return Promise.all(
    WORKSPACE_SCOPED_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  );
}
