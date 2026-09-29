import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import type { Message } from "@/lib/agents-store";
import { cn } from "@/lib/utils";

/**
 * One question in a transcript.
 *
 * It closes over nothing. WHICH message is open for editing lives in the
 * route — the composer's ArrowUp shortcut reads the same state — and so does
 * whether there are uploads still arriving. What reaches here is a message, a
 * name to put above it when there is one, and what the reader may do about it.
 *
 * `sender` is resolved by the caller rather than read off the message. Every
 * row in a private session has one and there is nobody to tell it apart from;
 * printing your own name over your own question is furniture.
 *
 * `footer` is a SLOT and not a prop shaped like uploads. What hangs there is
 * "the receipts for files still going up, under the last question only" — a
 * condition about the list, which this component cannot see and should not
 * learn. Taking `uploads` instead would tie a turn to the return type of
 * `useChatUploads`.
 */
export function QuestionTurn({
  message,
  sender,
  time,
  canEdit,
  busy,
  onEdit,
  footer,
  className,
}: {
  message: Message;
  sender: { name: string | null; avatarUrl: string | null } | null;
  /** Already formatted. A turn should not own a locale. */
  time: string;
  /**
   * Ownership, not role. `messages_update_owner` is keyed to whoever owns the
   * SESSION, so this used to branch on the same flag as the layout and put an
   * Edit button over a colleague's message that answered 404. Editing also
   * discards every reply after the edited turn, which is not something to
   * offer over somebody else's conversation even where the policy allowed it.
   */
  canEdit: boolean;
  busy: boolean;
  onEdit: (id: string, content: string) => void;
  footer?: ReactNode;
  /** How much air goes above this turn. See `gapBefore`. */
  className?: string;
}) {
  return (
    <div className={cn("group flex flex-col items-end gap-1.5", className)}>
      {sender && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          {sender.avatarUrl ? (
            <img src={sender.avatarUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
          ) : null}
          <span>{sender.name ?? "Someone"}</span>
        </div>
      )}
      {/* The clock and the one thing you can do to your own turn, ABOVE the
          bubble rather than under it.

          This reverses a decision, and the reason it can be reversed is that
          the rest of the screen changed around it. The time sat underneath
          once, to keep a second piece of furniture out of the gap between
          every pair of messages. That gap is no longer uniform: a question and
          its answer are 20px apart and one exchange is 44px from the next, so
          there is a wide gap above a question and a tight one below it. Small
          print belongs in the wide one — under the bubble it was wedged into
          the single gap that has to read as "these two belong together".

          It is also hidden until wanted, which the old position could not be:
          a line between two messages leaves a hole when it disappears, and a
          line above one does not.

          THE TWO REVEALS ARE BOTH LOAD-BEARING. `focus-within` is how this
          exists for a keyboard, and `[@media(hover:none)]` is how it exists on
          a phone — where `group-hover` alone means no timestamp and no way to
          fix a typo, ever. Failure mode #5 is not only about keyboards. */}
      <div
        data-part="meta"
        className="flex items-center gap-2 px-1 text-xs text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <span className="tabular-nums">{time}</span>
        {canEdit && (
          <button
            onClick={() => onEdit(message.id, message.content)}
            disabled={busy}
            className="flex items-center gap-1 transition-colors hover:text-foreground disabled:hidden"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {/* Warm fill, not ink.

          `bg-primary` made the question the heaviest object on the screen, so
          the eye landed on what the reader had typed rather than on the answer
          under it — the opposite of the relationship every chat product they
          arrive from has. `--bubble` is two steps down from the canvas: enough
          to read as an opened area, not enough to compete.

          No tail: `rounded-br-sm` pointed at an avatar that is not there. No
          pixel width either — a percentage, so a four-word question draws a
          four-word box instead of a paragraph-sized slab. */}
      <div
        data-part="bubble"
        className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-bubble px-4 py-3 text-base text-foreground"
      >
        {message.content}
      </div>
      {footer}
    </div>
  );
}
