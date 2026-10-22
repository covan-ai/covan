/**
 * What somebody put off for now (a banner's ×, an invitation's Ignore), for
 * the rest of this tab's session. Browser storage can be missing or refuse;
 * then nothing is remembered and the banner comes back on the next render.
 */
const KEY = "covan:dismissed";

function read(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function isDismissed(id: string): boolean {
  return read().includes(id);
}

export function dismiss(id: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...new Set([...read(), id])]));
  } catch {
    // Nothing to keep it in; it shows again, which is the safe way to fail.
  }
}
