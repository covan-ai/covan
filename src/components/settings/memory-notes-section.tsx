import { useId, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { api, ApiError, type MemoryNote } from "@/lib/api-client";
import { useWorkspaceRole } from "@/lib/workspace-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyWell } from "@/components/empty-page";
import { SectionLabel } from "@/components/section";

/** The longest a note may be; the API refuses more and names this number. */
const NOTE_MAX = 280;

/**
 * One group of what the agents keep in mind (Settings › Memory): an eyebrow, a
 * line saying who can read it, the notes, and the form that adds one.
 *
 * The page decides which notes belong here and whether the caller may add; the
 * section decides what each row offers. Delete is the author's on a private
 * note and a writer's on a team one — the database refuses the rest, so a
 * viewer is not shown a button that can only fail. Share with team is offered
 * on a private note about the team, to writers only, for the same reason.
 */
export function MemoryNotesSection({
  label,
  lede,
  notes,
  canAdd,
  about,
  onChanged,
}: {
  label: string;
  lede: string;
  notes: MemoryNote[];
  canAdd: boolean;
  about: "person" | "team";
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { canWrite } = useWorkspaceRole();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  /** Runs one change; the API's own sentence is the error, since it names what to shorten. */
  async function run(key: string, change: () => Promise<unknown>, done: string, failed: string) {
    setBusy(key);
    try {
      await change();
      toast.success(done);
      onChanged();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : failed);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ok = await run(
      "add",
      () => api.memory.add({ text: trimmed, about }),
      t("Added"),
      t("Couldn't save that"),
    );
    if (ok) setText("");
  }

  return (
    <section aria-label={label} className="mt-8 first:mt-0">
      <SectionLabel>{label}</SectionLabel>
      <p className="mb-2 text-meta text-muted-foreground">{lede}</p>

      {notes.length === 0 ? (
        <EmptyWell
          title={t("Nothing yet. Tell an agent something worth keeping, or write it here.")}
        />
      ) : (
        <ul className="m-0 list-none border-y border-hairline p-0">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              busy={busy !== null}
              canDelete={n.scope === "owner" || canWrite}
              canShare={canWrite && n.about === "team" && n.scope === "owner"}
              onDelete={() =>
                run(n.id, () => api.memory.remove(n.id), t("Deleted"), t("Couldn't delete that"))
              }
              onShare={() =>
                run(
                  n.id,
                  () => api.memory.update(n.id, { scope: "workspace" }),
                  t("Shared with the team"),
                  t("Couldn't save that"),
                )
              }
            />
          ))}
        </ul>
      )}

      {canAdd && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("A note to keep in mind")}
              placeholder={t("A note to keep in mind")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={NOTE_MAX}
            />
            <Button type="submit" disabled={busy !== null || !text.trim()}>
              {t("Add")}
            </Button>
          </div>
          <span className="mt-1 block text-right text-xs text-micro-foreground tabular-nums">
            {text.length}/{NOTE_MAX}
          </span>
        </form>
      )}
    </section>
  );
}

function NoteRow({
  note,
  busy,
  canDelete,
  canShare,
  onDelete,
  onShare,
}: {
  note: MemoryNote;
  busy: boolean;
  canDelete: boolean;
  canShare: boolean;
  onDelete: () => void;
  onShare: () => void;
}) {
  const { t } = useTranslation();
  const textId = useId();
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-hairline px-2 py-2 text-sm last:border-b-0">
      <div className="min-w-0 flex-1">
        <p id={textId} className="m-0 font-medium [overflow-wrap:anywhere]">
          {note.text}
        </p>
        <span className="text-meta text-muted-foreground">
          {note.source === "agent" ? t("From a conversation") : t("Written here")}
        </span>
      </div>
      {canShare && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-describedby={textId}
          onClick={onShare}
        >
          {t("Share with team")}
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-describedby={textId}
          onClick={onDelete}
        >
          {t("Delete")}
        </Button>
      )}
    </li>
  );
}
