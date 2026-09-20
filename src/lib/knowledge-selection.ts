/**
 * The two answers a multi-select file list has to give, away from the component
 * that draws it: which rows a shift-click covers, and which documents a drop
 * carries.
 *
 * Both are pure and both are the part that can be wrong in a way nobody sees
 * until files are in the wrong place, which is why they are here with tests
 * rather than inline in an event handler.
 */

/** The minimum a document needs for either answer. */
export type SelectableDocument = { id: string; bundleId?: string };

/**
 * The selection after a shift-click, as a file explorer means it: everything
 * between the last row that was clicked and this one, added to what was already
 * selected.
 *
 * Added rather than replaced, because shift-clicking a second range after
 * ctrl-clicking a few singles is how somebody collects a set that is not
 * contiguous. Anchor missing — the first click of the session, or a row that has
 * since been filtered away — falls back to selecting the one row, which is what
 * a plain click would have done.
 */
export function rangeSelect(
  order: string[],
  anchorId: string | null,
  targetId: string,
  current: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  const to = order.indexOf(targetId);
  const from = anchorId ? order.indexOf(anchorId) : -1;
  if (to < 0 || from < 0) {
    next.add(targetId);
    return next;
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) next.add(order[i]);
  return next;
}

/**
 * Which documents a drop onto a bundle actually moves.
 *
 * Dragging a row that is part of the selection takes the whole selection with
 * it; dragging one that is not takes that row alone and leaves the selection
 * untouched — the rule every file manager uses, and the one that stops a drag
 * from quietly moving files somebody selected minutes ago and forgot.
 *
 * A document already in the target bundle is dropped from the list rather than
 * sent: `PATCH /documents/:id` with the bundle it is already in is a request
 * whose success would say nothing happened, and in a batch it would be counted
 * as a file that moved.
 */
export function dropPayload<T extends SelectableDocument>(
  activeId: string,
  targetBundleId: string,
  selected: ReadonlySet<string>,
  documents: readonly T[],
): T[] {
  const dragged = selected.has(activeId)
    ? documents.filter((d) => selected.has(d.id))
    : documents.filter((d) => d.id === activeId);
  return dragged.filter((d) => d.bundleId !== targetBundleId);
}
