import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
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
    const failed: string[] = [];
    for (const email of wanted) {
      try {
        await api.invitations.create({ email, role: "member" });
      } catch (err) {
        failed.push(err instanceof ApiError ? `${email} (${err.message})` : email);
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });

    if (failed.length === wanted.length) {
      toast.error(`Couldn't invite ${failed.join(", ")}.`);
      setSending(false);
      return;
    }
    if (failed.length > 0) {
      toast.warning(`Invited the rest, but not ${failed.join(", ")}.`);
    } else {
      toast.success(wanted.length === 1 ? "Invitation sent" : `${wanted.length} invitations sent`);
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
