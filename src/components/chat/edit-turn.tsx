import { Textarea } from "@/components/ui/textarea";
import { useAutoGrow } from "@/lib/use-auto-grow";
import { cn } from "@/lib/utils";

/**
 * A past question, open for editing.
 *
 * Its own component only so it can hold a hook: `useAutoGrow` cannot be called
 * from inside the message loop, which renders this conditionally. The box had
 * the same fixed-height problem as the composer and for the same reason — two
 * rows, no growing — and it is the worse of the two places to have it, because
 * what is being edited is by definition something already long enough to be
 * worth fixing.
 *
 * WHICH message is open stays in the route. `editingId` and the draft are read
 * by the composer's ArrowUp shortcut as well as by the loop, so moving them
 * here would mean the composer reaching into this component for them.
 */
export function EditTurn({
  value,
  onChange,
  onCancel,
  onSave,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
  /** How much air goes above this turn. See `gapBefore`. */
  className?: string;
}) {
  const ref = useAutoGrow<HTMLTextAreaElement>(value);
  return (
    <div className={cn("flex flex-col items-end gap-1.5", className)}>
      {/* The same fill and the same corner as the bubble it stands in for —
          this is that message, opened, and a different surface would read as
          the message having been replaced by a dialog. The border is the only
          thing that differs, and it is what says "editable". */}
      <div
        data-part="bubble"
        className="w-full max-w-[80%] rounded-2xl border border-border bg-bubble p-2"
      >
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && value.trim()) {
              e.preventDefault();
              onSave();
            }
          }}
          rows={1}
          autoFocus
          aria-label="Edit your message"
          className="max-h-60 min-h-[40px] resize-none overflow-y-auto border-0 bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex justify-end gap-1.5 pt-1">
          <button
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!value.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save & send
          </button>
        </div>
      </div>
    </div>
  );
}
