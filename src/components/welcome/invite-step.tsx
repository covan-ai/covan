import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { invitationNotice } from "@/lib/invitation-notice";
import { copyInviteText } from "@/lib/invite-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const ROWS = 3;

/**
 * Three empty rows, none required. Shown only when the team is bigger than one
 * person — asking someone who just said "just me" to invite their team is a
 * question we already know the answer to.
 */
export function InviteStep({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState<string[]>(Array(ROWS).fill(""));
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const wanted = emails.map((v) => v.trim()).filter(Boolean);
    if (wanted.length === 0) {
      onDone();
      return;
    }

    setSending(true);
    // One at a time, and a failure on one address does not discard the others.
    const invited: string[] = [];
    const failed: string[] = [];
    // Which ones, not just how many: these are the addresses the copy action
    // below has to name, and each person needs their own.
    const unmailed: string[] = [];
    for (const email of wanted) {
      try {
        const invite = await api.invitations.create({ email, role: "member" });
        invited.push(invite.email);
        // Undefined means "this response does not know", which is not the same
        // as false — but no create response omits it, and counting an unknown
        // as unsent is the error that costs nothing.
        if (!invite.emailed) unmailed.push(invite.email);
      } catch (err) {
        failed.push(err instanceof ApiError ? `${email} (${err.message})` : email);
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });

    // This step used to report "N invitations sent" whichever way it went. On
    // an install with no mail configured — a supported one — that was three
    // people invited, nobody told, and the inviter assured otherwise.
    const notice = invitationNotice({ invited, emailed: invited.length - unmailed.length, failed });
    // This is the surface where the gap hurts most: the first run, on an
    // install with no mail configured, invites three people and then moves on
    // to the next step forever. The Team page keeps a copy button per waiting
    // invitation, but nobody has seen the Team page yet.
    toast[notice.tone](
      notice.message,
      unmailed.length === 0
        ? undefined
        : {
            duration: 12000,
            action: {
              label: unmailed.length === 1 ? "Copy invite text" : "Copy invite texts",
              onClick: () => copyInviteText(unmailed),
            },
          },
    );

    if (invited.length === 0) {
      // Nothing landed. Stay put so the addresses can be corrected rather than
      // making them retype three of them on another screen.
      setSending(false);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2.5">
        <Label htmlFor="invite-0">Email addresses</Label>
        {emails.map((value, i) => (
          <Input
            key={i}
            id={`invite-${i}`}
            type="email"
            value={value}
            placeholder="teammate@company.com"
            autoComplete="off"
            aria-label={`Teammate ${i + 1} email`}
            onChange={(e) =>
              setEmails((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
            }
          />
        ))}
      </div>

      <div className="space-y-2.5">
        <Button type="submit" className="w-full" disabled={sending}>
          {sending ? "Sending…" : "Send invitations"}
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="w-full text-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Skip for now
        </button>
      </div>
    </form>
  );
}
