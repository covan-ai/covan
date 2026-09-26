import type { SupportedStorage } from "@supabase/supabase-js";

/**
 * The storage behind the sign-in page's "Remember me".
 *
 * supabase-js chooses its session store once, when the client is constructed,
 * so the answer cannot simply be passed to `signInWithPassword` later. This
 * adapter defers the choice to every read and write instead: the checkbox
 * records a flag, and the flag decides which Web Storage holds the session.
 * Checked means localStorage and outliving the browser; cleared means
 * sessionStorage and dying with the tab.
 */

/**
 * Only which store holds the session — never the session. Kept in the clear.
 *
 * It lives in the store it describes, which is the whole of how long it lasts:
 * a cleared box writes it to sessionStorage beside the session it applies to,
 * and closing the tab takes both. "Remember me" is a question about one
 * sign-in, so an answer that outlived the session would be answering for
 * sign-ins nobody asked about — see `adoptLegacyRemember` for what that cost.
 */
const REMEMBER_KEY = "covan.auth.remember";

/**
 * supabase-js namespaces everything it stores under the project ref, so this
 * prefix is what a sweep has to recognise. The alternative — pinning our own
 * `storageKey` — would move every existing session to a key nothing reads and
 * sign the whole userbase out on deploy.
 */
const SUPABASE_PREFIX = "sb-";

/**
 * SSR renders both auth surfaces with no `window`, and supabase-js reaches for
 * storage while the client module is still being evaluated. A per-process Map
 * keeps that path from throwing. Nothing signs in on the server, so it stays
 * empty — and being module-scoped, it must never hold anything request-shaped.
 */
const serverStorage = new Map<string, string>();

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/**
 * Absent means remembered. That was the behaviour before this flag existed, and
 * defaulting the other way would evict everyone currently holding a session in
 * localStorage the first time they loaded the new build. It is also the right
 * answer for a session created without anybody being asked — a confirmation or
 * recovery link, which supabase-js builds from the URL during
 * `detectSessionInUrl` before any route of ours has mounted.
 */
function isRemembered(): boolean {
  return window.sessionStorage.getItem(REMEMBER_KEY) !== "false";
}

function active(): Storage {
  return isRemembered() ? window.localStorage : window.sessionStorage;
}

/** Drops supabase's keys from a store. The flag is not one of them — it carries no prefix. */
function evictSession(store: Storage): void {
  const doomed: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(SUPABASE_PREFIX)) doomed.push(key);
  }
  for (const key of doomed) store.removeItem(key);
}

/**
 * Records the answer and clears whichever store it just turned off, so a
 * session written under the opposite answer cannot outlive the change — a
 * cleared box has to leave no refresh token behind on the machine.
 *
 * Call this before signing in: the session is written the moment the sign-in
 * call returns, and by then the choice has to already be made.
 */
export function setRemember(remember: boolean): void {
  if (!hasWindow()) return;
  // Only "no" is written down. Absent already means remembered, so recording a
  // yes would be leaving behind exactly the kind of standing answer this key
  // stopped being.
  if (remember) window.sessionStorage.removeItem(REMEMBER_KEY);
  else window.sessionStorage.setItem(REMEMBER_KEY, "false");
  evictSession(remember ? window.sessionStorage : window.localStorage);
}

/**
 * Takes over an answer written by the build that kept this flag in
 * localStorage, once, at module load.
 *
 * This has to run before the first read. Everybody who ever cleared the box is
 * carrying `"false"` in localStorage with their session in sessionStorage, and
 * a build that simply looked in the new place would find no answer, resolve
 * `active()` to localStorage, find no session there either, and sign that tab
 * out on the spot — shipping this file's own bug as the fix for it.
 *
 * So the answer is moved to where it now belongs, which keeps that tab exactly
 * as it was, and removed from where it must not outlive the tab. One tab
 * lifetime later there is nothing left to migrate.
 */
export function adoptLegacyRemember(): void {
  if (!hasWindow()) return;
  const legacy = window.localStorage.getItem(REMEMBER_KEY);
  if (legacy === null) return;
  if (legacy === "false" && window.sessionStorage.getItem(REMEMBER_KEY) === null) {
    window.sessionStorage.setItem(REMEMBER_KEY, "false");
  }
  window.localStorage.removeItem(REMEMBER_KEY);
}

adoptLegacyRemember();

export const authStorage: SupportedStorage = {
  getItem(key) {
    // Deliberately reads one store, not both: falling back to the other would
    // resurrect the session that clearing the box was supposed to destroy.
    return hasWindow() ? active().getItem(key) : (serverStorage.get(key) ?? null);
  },
  setItem(key, value) {
    if (hasWindow()) active().setItem(key, value);
    else serverStorage.set(key, value);
  },
  removeItem(key) {
    // Signing out has to mean signed out of both, whatever the flag says now —
    // and the answer goes with the session it was given about, so the next
    // sign-in in this tab starts from the default rather than from it.
    if (hasWindow()) {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
      window.sessionStorage.removeItem(REMEMBER_KEY);
    } else {
      serverStorage.delete(key);
    }
  },
};
