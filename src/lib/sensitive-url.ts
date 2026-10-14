/**
 * What a connect flow brings back in the address bar, taken out of it before
 * anything else reads it.
 *
 * A provider's redirect lands on `/integrations?grant=…` (Notion, Drive,
 * Slack) or `/integrations?composio=…&nonce=…` (a connected application). Each
 * is the one thing that finishes a connection, so it should not sit in the
 * history, in a copied link, or in what analytics records about the page. This
 * runs once, when the app's root module loads — before the router renders and
 * before the page view is sent — keeps the values in this tab's session
 * storage for `/integrations` to finish with, and leaves the address bar with
 * nothing but the path and any harmless parameters (`error`).
 *
 * Whoever lands with a grant before signing in keeps it here through the
 * sign-in, and the app sends them on to `/integrations` once they are in.
 */
const KEY = "covan.pending-grant";

export type PendingGrant =
  | { kind: "oauth"; grant: string; for: "connection" | "slack" }
  | { kind: "composio"; toolkit: string; nonce: string };

const SENSITIVE = ["grant", "for", "composio", "nonce"];

/** Move a grant out of the URL into session storage. Safe to call on any page. */
export function takeSensitiveParams(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!SENSITIVE.some((p) => url.searchParams.has(p))) return;

  const grant = url.searchParams.get("grant");
  const forWhat = url.searchParams.get("for");
  const toolkit = url.searchParams.get("composio");
  const nonce = url.searchParams.get("nonce");
  let pending: PendingGrant | null = null;
  if (grant && (forWhat === "connection" || forWhat === "slack")) {
    pending = { kind: "oauth", grant, for: forWhat };
  } else if (toolkit && nonce) {
    pending = { kind: "composio", toolkit, nonce };
  }
  if (pending) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(pending));
    } catch {
      // Storage blocked: the connection is not finished, and the page says so.
    }
  }

  for (const p of SENSITIVE) url.searchParams.delete(p);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function hasPendingGrant(): boolean {
  try {
    return sessionStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** The pending grant, once: reading it removes it, so it is finished at most once. */
export function takePendingGrant(): PendingGrant | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return raw ? (JSON.parse(raw) as PendingGrant) : null;
  } catch {
    return null;
  }
}
