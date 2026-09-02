import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { FeedbackDialog } from "@/components/feedback-dialog";

/**
 * The way to say something is wrong, from inside the thing that is wrong.
 *
 * The first outside walkthrough of a new account found four defects in five
 * minutes, and the only reason anybody heard about them was a phone number.
 * This is the version of that for everyone else.
 *
 * It sits above the account menu rather than inside it: somebody who has just
 * hit a problem should not have to guess that the way to say so is behind their
 * own name.
 */
export function FeedbackButton({ path, onOpen }: { path: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);

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

      <FeedbackDialog open={open} onOpenChange={setOpen} path={path} />
    </>
  );
}
