import { useRef, useState } from "react";
import { Pencil, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatSession } from "@/lib/agents-store";

/**
 * As wide a name as the API will store. Mirrors TITLE_INPUT_MAX_CHARS in
 * worker/src/routes/sessions.ts — the field stops accepting characters at the
 * point where the server would start refusing them, so nobody types a name and
 * is told afterwards that it was too long.
 */
const TITLE_MAX_CHARS = 120;

/**
 * One conversation in the sidebar: open it, rename it, delete it.
 *
 * Extracted because the sidebar draws this twice — once for the team's shared
 * threads and once for your own — and rename is a small state machine that
 * would have been written out twice and drifted apart the first time either
 * copy was touched.
 */
export function SessionRow({
  session,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter both saves and closes the field, and closing it can fire blur — which
  // would save again. Whichever of the two arrives first settles the edit and
  // the other becomes a no-op.
  const settled = useRef(false);

  const label = session.title || (session.kind === "brainstorm" ? "New brainstorm" : "New chat");

  const startEditing = () => {
    setDraft(session.title ?? "");
    settled.current = false;
    setEditing(true);
  };

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    // Nothing typed, or nothing changed: a rename that would land the session
    // on the name it already has is a round trip and a re-sort for no reason.
    if (next.length === 0 || next === (session.title ?? "")) return;
    onRename(session.id, next);
  };

  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-200",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      {editing ? (
        <input
          // Focused on open: the field exists because the user just asked to
          // rename, so anywhere else is the wrong place for the caret.
          autoFocus
          aria-label="Chat name"
          value={draft}
          maxLength={TITLE_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm text-sidebar-foreground outline-none ring-1 ring-sidebar-border focus:ring-ring"
        />
      ) : (
        <>
          <button
            onClick={() => onOpen(session.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
          >
            {session.visibility === "shared" && (
              <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {session.kind === "brainstorm" && <span className="mr-1">🧠</span>}
              {label}
            </span>
          </button>
          <button
            onClick={startEditing}
            className="shrink-0 opacity-0 transition-opacity hover:text-sidebar-foreground group-hover:opacity-100"
            aria-label="Rename chat"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete(session.id)}
            className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            aria-label="Delete chat"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
