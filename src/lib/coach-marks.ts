import { useSyncExternalStore } from "react";
import type { CoachTarget } from "./onboarding-config";

/**
 * The one coach mark that can be open, held outside React.
 *
 * A module store rather than a context, because the thing that opens a mark
 * (a "Try" button in the sidebar) and the thing that draws it (`CoachMarkLayer`,
 * mounted once beside the router's outlet) share no ancestor worth threading a
 * provider through. `useSyncExternalStore` is the same move `first-week.ts`
 * makes for its dismissal flag.
 */

export type CoachMarkRequest = {
  target: CoachTarget;
  /** Where focus goes back to when the mark closes. */
  returnFocusTo: HTMLElement | null;
  /** Counts up per request, so two "Try"s on the same target are two marks. */
  seq: number;
};

let current: CoachMarkRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openCoachMark(
  target: CoachTarget,
  opts: { returnFocusTo?: HTMLElement | null } = {},
): void {
  seq += 1;
  current = { target, returnFocusTo: opts.returnFocusTo ?? null, seq };
  emit();
}

export function closeCoachMark(): void {
  if (!current) return;
  const { returnFocusTo } = current;
  current = null;
  emit();
  // After the layer has gone, so the focus does not land on a button that is
  // still behind an overlay for one frame.
  if (returnFocusTo && returnFocusTo.isConnected) {
    queueMicrotask(() => returnFocusTo.focus());
  }
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useCoachMark(): CoachMarkRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** For tests. */
export function _resetCoachMarks(): void {
  current = null;
  emit();
}
