import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "theme";

// Injected into <head> and executed before hydration so the correct theme is
// applied before first paint — prevents a flash of the wrong theme (FOUC) and
// keeps the server/client DOM class in sync. Default (nothing stored) follows
// the device's `prefers-color-scheme`. Kept dependency-free and inline.
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var dark = (stored === 'light' || stored === 'dark')
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function systemTheme(): Theme {
  return window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light";
}

function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * The stored preference, or "system" when there is none or it cannot be read.
 *
 * The absence of a value IS "system" — see `writePreference` — so a storage
 * failure lands on the same answer as a first visit rather than on an error.
 */
function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function writePreference(pref: ThemePreference) {
  try {
    // "system" is the default, represented by the absence of a stored value —
    // so following the device stays the behavior across future visits.
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore — private mode / storage disabled
  }
}

/*
 * There are two sources of truth here and neither of them is React: the stored
 * preference, and what the device says. So the hooks below read them during
 * render through `useSyncExternalStore` rather than copying them into state
 * after mount, which is what this file used to do and what
 * `react-hooks/set-state-in-effect` reported.
 *
 * What that replaces is worth naming, because it was more than one extra
 * render. `useTheme` held three pieces of state, seeded them all in one effect,
 * and exported a `mounted` flag purely so callers could hide theme-dependent
 * markup until that effect had run. The flag existed to paper over the gap
 * between the first render and the effect — and with the browser read during
 * render, the gap it papered over is the ordinary hydration boundary that
 * `useSyncExternalStore` already handles, by rendering the server snapshot and
 * then re-rendering with the client's.
 *
 * `mounted` stays in the returned shape, because it is still the right answer
 * to "may I draw something that differs between server and client yet", and
 * because three call sites use it. It is just honest now rather than a state
 * machine.
 *
 * The snapshots are strings on purpose. `useSyncExternalStore` compares
 * snapshots by identity and would loop forever on a fresh object each call.
 */
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  const mq = window.matchMedia(SYSTEM_DARK);
  mq.addEventListener("change", onStoreChange);
  // Another tab choosing a theme. The old effect never listened for this, so
  // two open tabs disagreed until one of them was reloaded.
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    mq.removeEventListener("change", onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * Reads and controls the active theme. The default preference is "system",
 * which tracks the device's colour scheme live.
 *
 * The server renders "light" and "system", matching `THEME_INIT_SCRIPT`'s
 * fallback; the client's first snapshot is whatever the device and storage
 * actually say. Gate theme-dependent markup on `mounted` as before.
 */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const theme = useSyncExternalStore(
    subscribe,
    () => resolve(readPreference()),
    () => "light" as const,
  );
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  // Updating something outside React from React's own state, which is what an
  // effect is for. The init script has already set this class before first
  // paint, so on load this agrees with what is on the element and changes
  // nothing; it earns its keep when the device flips at midnight or somebody
  // picks a theme in another tab.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setPreference = (pref: ThemePreference) => {
    writePreference(pref);
    // `storage` does not fire in the tab that wrote it.
    notify();
  };

  return {
    theme,
    preference,
    mounted,
    setPreference,
    // Explicit binary flip (leaves "system"); kept for existing call sites.
    toggle: () => setPreference(theme === "dark" ? "light" : "dark"),
  };
}
