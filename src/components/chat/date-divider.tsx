/**
 * "Today", "Yesterday", "March 4" — the one thing between two turns.
 *
 * Its own component because three of the four branches in the message loop
 * draw it, and it used to be written out in exactly one of them: a day that
 * began with a question rather than an answer got no divider at all.
 *
 * It takes a label and nothing else. WHICH messages get one is
 * `dateDividers` in `lib/message-groups.ts`, and the separation matters: a
 * divider is a sibling of a turn rather than part of one, so no component that
 * owns a turn can own it.
 */
export function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
