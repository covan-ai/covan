import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import type { Message } from "@/lib/agents-store";

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
}) {
  return (
    <div className="group flex flex-col items-end gap-1.5">
      {sender && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          {sender.avatarUrl ? (
            <img src={sender.avatarUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
          ) : null}
          <span>{sender.name ?? "Someone"}</span>
        </div>
      )}
      <div className="max-w-[560px] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-base text-primary-foreground">
        {message.content}
      </div>
      {footer}
      {/* The clock and the one thing you can do to your own turn, on a single
          line under it. The time used to have a line of its own *above* the
          bubble, which put a second piece of furniture between every pair of
          messages in the transcript.

          `focus-visible:opacity-100` is not decoration: the button is revealed
          on hover, so focus has to reveal it too or it does not exist for a
          keyboard. Failure mode #5. */}
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{time}</span>
        {canEdit && (
          <button
            onClick={() => onEdit(message.id, message.content)}
            disabled={busy}
            className="flex items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
    </div>
  );
}
