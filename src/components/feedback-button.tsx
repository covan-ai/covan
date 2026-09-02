import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
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
 * The way to say something is wrong, from inside the thing that is wrong.
 *
 * The first outside walkthrough of a new account found four defects in five
 * minutes, and the only reason anybody heard about them was a phone number.
 * This is the version of that for everyone else.
 *
 * Two promises the dialog makes, both of which the schema keeps (0039): the
 * operator is the only reader, and no reply is coming. The second is the one
 * worth being blunt about — there is no ticket and no inbox behind this, and a
 * box that implies a conversation it cannot have is worse than no box.
 */

const KINDS: { key: FeedbackKind; label: string }[] = [
  { key: "problem", label: "Something's broken" },
  { key: "idea", label: "An idea" },
  { key: "other", label: "Something else" },
];

/** Matches the check constraint on `feedback.message`. */
const MAX_MESSAGE = 4000;

export function FeedbackButton({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  /**
   * Null until somebody picks, and stored as "other" if they never do.
   *
   * Pre-selecting "Something else" would put an amber chip on the screen before
   * anybody had chosen anything — an amber element that points at nothing,
   * which is the one thing DESIGN.md asks the colour not to do. It would also
   * be a small lie about the row: "other" as a fallback and "other" as a
   * decision look identical afterwards, but only one of them was made.
   */
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const written = message.trim();
    if (!written || sending) return;
    setSending(true);
    try {
      await api.feedback.send({ message: written, kind: kind ?? "other", path });
      // Cleared only once it is somewhere else. See the catch.
      setMessage("");
      setKind(null);
      setOpen(false);
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
    <>
      <button
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      >
        {/* No amber square: the nav rows use one to mark which page you are on,
            and this opens a dialog rather than going anywhere. */}
        <span aria-hidden className="h-1 w-1 shrink-0 bg-transparent" />
        <MessageSquarePlus className="h-4 w-4" />
        Send feedback
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              This goes to whoever runs this Covan, and to nobody in your workspace. There's no
              reply — it's a note, not a ticket.
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
              placeholder="What you were doing, and what you expected instead."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            {/* Said out loud rather than attached quietly. The privacy page
                promises there is no invisible collection, and one line of
                context is not an exception to that. */}
            <p className="text-xs text-muted-foreground">
              Sent with the page you're on (<span className="font-mono">{path}</span>) so nobody has
              to describe where they were.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={() => void send()} disabled={!message.trim() || sending}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
