import { useSyncExternalStore } from "react";

/*
 * The dismissal flag lives in `localStorage`, same reasoning and the same
 * shape as `useChecklistDismissed` in `src/lib/first-week.ts`: read during
 * render through `useSyncExternalStore` rather than copied into state after
 * mount, a module-level set alongside storage so one tab updates immediately,
 * and try/catch returning `false` so storage that throws shows the notice
 * again — the harmless direction.
 *
 * Kept in its own module rather than inside `components/coverage-notice.tsx`:
 * a file that exports both a component and a hook trips
 * `react-refresh/only-export-components`, and `first-week.ts` already drew
 * the line the same way — the hook lives in `lib/`, the component in
 * `components/`.
 */
const dismissListeners = new Set<() => void>();

/** Dismissals this tab has made, for when the write below them fails. */
const dismissedHere = new Set<string>();

function subscribeDismissed(onStoreChange: () => void) {
  dismissListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    dismissListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** Per workspace, same reason as the checklist's key: being told once about
    this workspace's report should not silence a second workspace's. */
function dismissKey(workspaceId: string | undefined) {
  return workspaceId ? `covan:coverage-notice-dismissed:${workspaceId}` : null;
}

/** Whether this browser has already been told about this workspace's coverage
    report — dismissal, not exclusion. See `CoverageNotice`'s docblock for the
    distinction. */
export function useCoverageNoticeDismissed(workspaceId: string | undefined) {
  const key = dismissKey(workspaceId);

  const dismissed = useSyncExternalStore(
    subscribeDismissed,
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
    for (const listener of dismissListeners) listener();
  };

  return { dismissed, dismiss };
}
