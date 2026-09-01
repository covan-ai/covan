import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useTheme } from "./theme";
import { useIsMobile } from "@/hooks/use-mobile";

/*
 * Both hooks mirror something outside React — the device's colour scheme, the
 * stored preference, the viewport width — and both used to copy it into state
 * after mount. These tests are about the copy being gone: what the hook returns
 * has to follow the browser, including when the browser changes underneath it.
 *
 * jsdom implements no `matchMedia` at all, so there is a small one here rather
 * than in `test-setup.ts`: only these two hooks need it, and a global stub
 * would let a future test rely on media queries working without saying so.
 */
type Listener = (event: MediaQueryListEvent) => void;

const media = new Map<string, { matches: boolean; listeners: Set<Listener> }>();

function setMedia(query: string, matches: boolean) {
  const entry = media.get(query);
  if (!entry) {
    media.set(query, { matches, listeners: new Set() });
    return;
  }
  entry.matches = matches;
  for (const listener of [...entry.listeners]) listener({ matches } as MediaQueryListEvent);
}

beforeEach(() => {
  media.clear();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  window.matchMedia = ((query: string) => {
    if (!media.has(query)) media.set(query, { matches: false, listeners: new Set() });
    const entry = media.get(query)!;
    return {
      get matches() {
        return entry.matches;
      },
      media: query,
      addEventListener: (_: string, listener: Listener) => entry.listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => entry.listeners.delete(listener),
    };
  }) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  media.clear();
});

const DARK = "(prefers-color-scheme: dark)";

describe("useTheme", () => {
  it("follows the device when nothing has been chosen", () => {
    setMedia(DARK, true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("dark");
  });

  it("reads the stored choice on the very first render", () => {
    // The point of the change. This used to be "light" for one render and then
    // the stored value, so anything drawn from it flickered.
    localStorage.setItem("theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.mounted).toBe(true);
  });

  it("lets an explicit choice beat the device", () => {
    setMedia(DARK, true);
    localStorage.setItem("theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("follows the device changing while the page is open", () => {
    setMedia(DARK, false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    act(() => setMedia(DARK, true));
    expect(result.current.theme).toBe("dark");
  });

  it("stops following the device once somebody chooses", () => {
    setMedia(DARK, false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("light"));
    act(() => setMedia(DARK, true));

    expect(result.current.theme).toBe("light");
    expect(result.current.preference).toBe("light");
  });

  it("stores nothing for 'system', because absence is what means system", () => {
    localStorage.setItem("theme", "dark");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("system"));

    expect(localStorage.getItem("theme")).toBeNull();
  });

  it("puts the class on the document, which is what the page is actually styled by", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => result.current.setPreference("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("agrees with a second hook in the same page", () => {
    // Two components both calling useTheme is the ordinary case — the shell and
    // the command palette both do. They share one subscription list, so a
    // choice made through one has to reach the other.
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());

    act(() => a.result.current.setPreference("dark"));

    expect(b.result.current.theme).toBe("dark");
  });

  it("toggle leaves an explicit choice behind, not 'system'", () => {
    setMedia(DARK, false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.preference).toBe("dark");
  });
});

describe("useIsMobile", () => {
  const NARROW = "(max-width: 767px)";

  it("answers from the media query on the first render", () => {
    setMedia(NARROW, true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("follows the viewport crossing the breakpoint", () => {
    setMedia(NARROW, false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => setMedia(NARROW, true));
    expect(result.current).toBe(true);
  });
});
