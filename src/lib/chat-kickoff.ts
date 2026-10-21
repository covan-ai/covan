import { useSyncExternalStore } from "react";

/**
 * The handoff from the end of the first run to the conversation it opens.
 *
 * Two flags, two lifetimes. The *fire* flag says "open this conversation when
 * you get there": the welcome screen sets it, the chat screen reads it once
 * and deletes it, the same way the home composer hands its draft over
 * (`chat-draft:<id>`). It lives in `sessionStorage` so a tab that never
 * arrives — closed on the way — leaves nothing behind. The *card* flag says
 * "the Connect card under the opening has been put down": that one has to
 * survive a reload, so it lives in `localStorage`, read the way
 * `useChecklistDismissed` reads its own.
 */

const fireKey = (sessionId: string) => `chat-kickoff:${sessionId}`;

export function markKickoff(sessionId: string): void {
  try {
    sessionStorage.setItem(fireKey(sessionId), "1");
  } catch {
    // Private mode or blocked storage. The conversation opens empty and the
    // Connect card still shows; only the greeting is lost.
  }
}

/** Whether to open this conversation now. Reading it is what spends it. */
export function takeKickoffFire(sessionId: string): boolean {
  try {
    const set = sessionStorage.getItem(fireKey(sessionId)) === "1";
    if (set) sessionStorage.removeItem(fireKey(sessionId));
    return set;
  } catch {
    return false;
  }
}

const cardKey = (sessionId: string) => `covan:kickoff-card:${sessionId}`;

const cardListeners = new Set<() => void>();
/** Dismissals this tab made, for when the write fails (private mode). */
const dismissedHere = new Set<string>();

function subscribeCard(onStoreChange: () => void) {
  cardListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    cardListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** Whether the Connect card under the opening has been put down for this conversation. */
export function useKickoffCardDismissed(sessionId: string | undefined) {
  const key = sessionId ? cardKey(sessionId) : null;

  const dismissed = useSyncExternalStore(
    subscribeCard,
    () => {
      if (!key) return false;
      if (dismissedHere.has(key)) return true;
      try {
        return window.localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    () => false,
  );

  const dismiss = () => {
    if (!key) return;
    dismissedHere.add(key);
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      /* back next reload; see above */
    }
    for (const listener of cardListeners) listener();
  };

  return { dismissed, dismiss };
}
