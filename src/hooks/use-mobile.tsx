import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onStoreChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

/**
 * Whether the viewport is narrower than the layout's one breakpoint.
 *
 * `useSyncExternalStore` rather than state seeded from an effect, which is what
 * this was. The old shape rendered `false` once, then set state after mount and
 * rendered again — so a phone got one frame of the desktop layout on every
 * mount, and `react-hooks/set-state-in-effect` reported it. This subscribes to
 * the media query and reads it during render instead, which is the whole job
 * this hook has.
 *
 * The reading is `mql.matches`, not `window.innerWidth`. The old code
 * registered on the media query and then measured the window, two sources for
 * one answer that disagree while a scrollbar is being counted.
 *
 * The server snapshot is `false` — there is no viewport during a server render,
 * and false is what the previous `!!isMobile` gave before mount, so the first
 * paint is unchanged.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** Tailwind's `lg`, where the chat's own header and rail change shape. */
const BELOW_LG = "(max-width: 1023px)";

function subscribeBelowLg(onStoreChange: () => void) {
  const mql = window.matchMedia(BELOW_LG);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

/**
 * Whether the viewport is narrower than `lg` — a second breakpoint, for the one
 * layout that needs it.
 *
 * The browser beside a conversation is a 16:9 picture of somebody else's
 * screen. Beside a chat column it needs room that a tablet in portrait does not
 * have, so below `lg` it becomes a full-height sheet rather than a split, and
 * `useIsMobile`'s 768 would leave a 900px window splitting it into two columns
 * too narrow to read either. Same mechanism as above, same server snapshot.
 */
export function useIsBelowLg() {
  return React.useSyncExternalStore(
    subscribeBelowLg,
    () => window.matchMedia(BELOW_LG).matches,
    () => false,
  );
}
