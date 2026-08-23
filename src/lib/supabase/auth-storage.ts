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

/** Only which store holds the session — never the session. Kept in the clear. */
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
 * localStorage the first time they loaded the new build.
 */
function isRemembered(): boolean {
  return window.localStorage.getItem(REMEMBER_KEY) !== "false";
}

function active(): Storage {
  return isRemembered() ? window.localStorage : window.sessionStorage;
}

/** Drops supabase's keys from a store without touching the flag, which lives in localStorage. */
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
  window.localStorage.setItem(REMEMBER_KEY, remember ? "true" : "false");
  evictSession(remember ? window.sessionStorage : window.localStorage);
}

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
    // Signing out has to mean signed out of both, whatever the flag says now.
    if (hasWindow()) {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    } else {
      serverStorage.delete(key);
    }
  },
};
