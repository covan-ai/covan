/**
 * The page somebody was sent to before signing in, for the pages worth coming
 * back to.
 *
 * Signing in always lands on `/app`. That is right for almost every page, and
 * wrong for one: a request an agent made while nobody was watching (0143),
 * whose email links to `/approvals/<id>`. Somebody opening that on a phone
 * they are not signed in on would sign in and be left on Home, with the
 * request they came to answer a search away. So the address waits here,
 * `invite-stash.ts`'s way, and the signed-in layout takes them back to it.
 *
 * Only the paths listed below: a stashed address is somewhere the app sends
 * you without asking, and the list keeps that to pages whose whole content is
 * read through the caller's own client. localStorage, because signing in can
 * mean a link opened in another tab; one day, because the request it leads to
 * waits that long. Every failure is silent: losing it costs one click.
 */
const KEY = "covan.return";
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const WORTH_COMING_BACK_TO = /^\/approvals\/[0-9a-f-]{36}$/i;

export function stashReturn(path: string, now = Date.now()): void {
  if (!WORTH_COMING_BACK_TO.test(path)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: now }));
  } catch {
    // Storage blocked: they open the email again.
  }
}

/** The stashed page, forgotten as it is handed back. */
export function takeReturn(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const entry = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof entry.path !== "string" || typeof entry.at !== "number") return null;
    if (now - entry.at > LIFETIME_MS || !WORTH_COMING_BACK_TO.test(entry.path)) return null;
    return entry.path;
  } catch {
    return null;
  }
}
