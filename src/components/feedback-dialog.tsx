import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, type FeedbackKind } from "@/lib/api-client";

/**
 * The one box for saying something is wrong, opened from two places.
 *
 * The sidebar opens it about the product. The chat opens it about one answer,
 * with the kind already chosen and the reply attached — which is what turned
 * two thumbs that stored nothing into something a person actually reads.
 *
 * What it was opened *with* is initial state, not synchronised state, so a
 * caller that opens it about different things gives it a `key` and gets a fresh
 * one each time. The sidebar does not, which is why a draft survives closing
 * the box there: an accidental Escape should not eat what somebody wrote, and
 * neither should a failed send.
 *
 * Two promises it makes, both of which the schema keeps (0039): the operator is
 * the only reader, and no reply is coming. The second is worth being blunt
 * about — there is no ticket and no inbox behind this, and a box that implies a
 * conversation it cannot have is worse than no box.
 */

const KINDS: { key: FeedbackKind; label: string }[] = [
  { key: "problem", label: "Something's broken" },
  { key: "idea", label: "An idea" },
  { key: "other", label: "Something else" },
];

/** Matches the check constraint on `feedback.message`. */
const MAX_MESSAGE = 4000;

/** The reply a note is about, when it started as a thumb under one. */
export type FeedbackAbout = { messageId: string; label: string };

export function FeedbackDialog({
  open,
  onOpenChange,
  path,
  about,
  initialKind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  about?: FeedbackAbout | null;
  initialKind?: FeedbackKind | null;
}) {
  /**
   * Null until somebody picks, and stored as "other" if they never do.
   *
   * Pre-selecting "Something else" would put an amber chip on the screen before
   * anybody had chosen anything — an amber element that points at nothing,
   * which is the one thing DESIGN.md asks the colour not to do. It would also
   * be a small lie about the row: "other" as a fallback and "other" as a
   * decision look identical afterwards, but only one of them was made.
   */
  const [kind, setKind] = useState<FeedbackKind | null>(initialKind ?? null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const written = message.trim();
    if (!written || sending) return;
    setSending(true);
    try {
      await api.feedback.send({
        message: written,
        kind: kind ?? "other",
        path,
        ...(about ? { messageId: about.messageId } : {}),
      });
      setMessage("");
      onOpenChange(false);
      toast.success("Sent. Thank you — somebody reads these.");
    } catch {
      // Deliberately keeps the box open and the words in it. Somebody who just
      // typed three paragraphs about a bug and hit a failed request must not
      // lose them to the thing they were reporting.
      toast.error("Couldn't send that. It's still here — try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            This goes to whoever runs this Covan, and to nobody in your workspace. There's no reply
            — it's a note, not a ticket.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={kind === option.key}
              onClick={() => setKind(option.key)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium leading-[1.4] transition-colors duration-200",
                kind === option.key
                  ? "bg-accent-orange text-accent-orange-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feedback-message">What happened</Label>
          <Textarea
            id="feedback-message"
            autoFocus
            rows={6}
            maxLength={MAX_MESSAGE}
            placeholder={
              about
                ? "What was wrong with it, or what you expected instead."
                : "What you were doing, and what you expected instead."
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {/* Said out loud rather than attached quietly. The privacy page
              promises there is no invisible collection, and neither the page
              nor the answer is an exception to that. */}
          <p className="text-xs text-muted-foreground">
            {about ? (
              <>
                Sent about <span className="font-medium text-foreground">{about.label}</span> and
                the page you're on (<span className="font-mono">{path}</span>), so nobody has to
                describe which one.
              </>
            ) : (
              <>
                Sent with the page you're on (<span className="font-mono">{path}</span>) so nobody
                has to describe where they were.
              </>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={!message.trim() || sending}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
