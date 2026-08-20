import { useEffect, useState } from "react";

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

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? systemTheme() : pref;
}

function applyPreference(pref: ThemePreference) {
  const theme = resolve(pref);
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    // "system" is the default, represented by the absence of a stored value —
    // so following the device stays the behavior across future visits.
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore — private mode / storage disabled
  }
}

/**
 * Reads and controls the active theme. The default preference is "system",
 * which tracks the device's color scheme live. Initial render assumes "light"
 * (matches SSR output); after mount it syncs to whatever the init script set,
 * so gate any theme-dependent icon on `mounted` to avoid a hydration mismatch.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const pref: ThemePreference = stored === "light" || stored === "dark" ? stored : "system";
    setPreferenceState(pref);
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    setMounted(true);

    // While following the device, react to OS light/dark changes live.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s === "light" || s === "dark") return; // explicit choice wins
      const next = mq.matches ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      setTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setPreference = (pref: ThemePreference) => {
    setPreferenceState(pref);
    applyPreference(pref);
    setTheme(resolve(pref));
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
