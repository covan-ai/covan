/**
 * The secret a connect flow is bound to, held by the tab that started it.
 *
 * Starting a connection — Notion, Drive, Slack — sends the API the SHA-256 of
 * a random nonce, and completing it sends the nonce itself. The provider's
 * redirect lands back in this same tab, so session storage still has it; a
 * consent link that reached anybody else's browser does not, and their browser
 * completes nothing. See `worker/src/lib/connections/oauth-state.ts`.
 *
 * Session storage rather than local: the flow belongs to one tab, and a second
 * tab starting another flow must not overwrite this one's.
 */
const KEY = "covan.flow-nonce";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh nonce for a flow about to start, kept in this tab; returns its hash. */
export async function beginFlow(): Promise<string> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    sessionStorage.setItem(KEY, nonce);
  } catch {
    // Storage blocked: the flow will not complete, and says so when it comes back.
  }
  return sha256Hex(nonce);
}

/** The nonce this tab started a flow with, if any. */
export function flowNonce(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function endFlow(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
