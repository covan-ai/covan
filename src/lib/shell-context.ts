/**
 * What frame a signed-in path is drawn in, decided from the path alone.
 *
 * The shell (DESIGN.md §6) is rendered once, in `routes/_authed.tsx`, so it
 * keeps its scroll, its open agent and its menus across every page change.
 * Two kinds of page are drawn without it: the welcome flow, which is a
 * centred card of its own, and a document's print view, which is paper.
 * Inside an agent the sidebar expands that agent, so the path's agent id is
 * handed to it here rather than by each page.
 */
export type ShellContext = { chrome: "app" | "bare"; agentId?: string };

export function shellFor(pathname: string): ShellContext {
  if (pathname === "/welcome" || pathname.startsWith("/welcome/")) return { chrome: "bare" };
  if (/^\/documents\/[^/]+\/print\/?$/.test(pathname)) return { chrome: "bare" };
  const agent = /^\/agents\/([^/]+)/.exec(pathname);
  if (agent) return { chrome: "app", agentId: decodeURIComponent(agent[1]!) };
  return { chrome: "app" };
}
