/**
 * The two-key shortcuts the ⌘K palette lists (A21): G then a letter goes to
 * a page; N starts a thread. Never while somebody is typing.
 */
export const GO_KEYS: Record<string, string> = {
  h: "/app",
  i: "/inbox",
  t: "/threads",
  k: "/knowledge",
  r: "/routines",
  m: "/team",
  s: "/settings/general",
};

/** The keycap the palette shows beside a page: "G I". */
export function goKeyFor(path: string): string | undefined {
  const key = Object.entries(GO_KEYS).find(([, to]) => to === path)?.[0];
  return key ? `G ${key.toUpperCase()}` : undefined;
}

/** Whether a key press is somebody typing rather than a shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Reads a stream of key presses: "g" arms a jump for one second, the next
 * letter picks the page. Returns where to go, or "new-thread" for N.
 */
export function goKeyReader(now: () => number = Date.now) {
  let armedAt: number | null = null;
  return (key: string): string | "new-thread" | null => {
    const k = key.toLowerCase();
    if (armedAt !== null && now() - armedAt < 1000) {
      armedAt = null;
      return GO_KEYS[k] ?? null;
    }
    armedAt = null;
    if (k === "g") {
      armedAt = now();
      return null;
    }
    if (k === "n") return "new-thread";
    return null;
  };
}
