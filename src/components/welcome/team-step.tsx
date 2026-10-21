import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { parseEmails, sendInvitations } from "@/lib/invite-send";
import { copyInviteText } from "@/lib/invite-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The team, in one screen: what the workspace is called, and who else is in it.
 *
 * Only shown once "my team" was picked — asking someone who just said "just
 * me" to invite their team is a question we already know the answer to. The
 * name is required and pre-filled with the guess the signup trigger made; the
 * addresses are not required at all.
 *
 * Invitations go out from here rather than at the finish, so the toast that
 * says whether an email actually reached anybody arrives while the addresses
 * are still on screen to correct.
 */
export function TeamStep({
  formId,
  currentName,
  onDone,
  onValidityChange,
  onBusyChange,
}: {
  formId: string;
  currentName: string | null;
  onDone: () => void;
  onValidityChange?: (valid: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName ?? "");
  const [emails, setEmails] = useState("");
  const [sending, setSending] = useState(false);

  const valid = name.trim().length > 0;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  useEffect(() => {
    onBusyChange?.(sending);
  }, [sending, onBusyChange]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      // Unchanged means nothing to write. Skipping the request keeps a no-op
      // from being able to fail.
      if (trimmed !== currentName) {
        try {
          await api.workspace.update({ name: trimmed });
          await queryClient.invalidateQueries({ queryKey: ["me"] });
        } catch {
          toast.error("Couldn't rename the workspace.");
          return;
        }
      }

      const wanted = parseEmails(emails);
      if (wanted.length > 0) {
        const outcome = await sendInvitations(wanted);
        await queryClient.invalidateQueries({ queryKey: ["invitations"] });
        // On an install with no mail configured the links exist only in these
        // responses, and this is the only place they can be copied from before
        // the Team page has been seen.
        toast[outcome.notice.tone](
          outcome.notice.message,
          outcome.copyable.length === 0
            ? undefined
            : {
                duration: 12000,
                action: {
                  label: outcome.copyable.length === 1 ? "Copy invite text" : "Copy invite texts",
                  onClick: () => copyInviteText(outcome.copyable),
                },
              },
        );
        if (outcome.invited.length === 0) {
          // Nothing landed. Stay put so the addresses can be corrected rather
          // than retyped on another screen.
          return;
        }
      }
      onDone();
    } finally {
      setSending(false);
    }
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input
          id="workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          autoFocus
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="invite-emails">Invite teammates</Label>
        <Textarea
          id="invite-emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="ada@acme.test, grace@acme.test"
          rows={3}
          className="resize-none"
          autoComplete="off"
        />
        <p className="text-meta leading-[1.45] text-muted-foreground">
          Separate addresses with commas. Optional — you can invite people from Settings later.
        </p>
      </div>

      <p className="rounded-lg border border-hairline bg-background px-4 py-3 text-meta leading-[1.45] text-muted-foreground">
        Everyone shares the one assistant and what it has learned, and pays for nothing twice. What
        each person asks it stays theirs.
      </p>
    </form>
  );
}
