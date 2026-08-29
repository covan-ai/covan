import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";

/**
 * Closing your account.
 *
 * The one thing on this page that cannot be undone, and the one thing the
 * software is not allowed to make you ask a human for: erasure is a right under
 * the GDPR and the KVKK rather than a courtesy, and until this shipped the only
 * way to exercise it was an email to whoever ran the install.
 *
 * Two refusals can come back from the server and only one of them is knowable
 * here. Being the last admin of a workspace other people are still in stops the
 * deletion, and finding that out would mean asking for every workspace's member
 * list up front — several requests, to render a sentence that is usually not
 * needed. So the request itself is the check: the server deletes nothing before
 * it decides, and a 409 names the workspaces in its message. The answer is
 * shown **inside this dialog** rather than as a toast, because it is an
 * instruction about what to go and do, not a notification that something
 * happened.
 */
export function CloseAccountSection({ email }: { email?: string | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [closing, setClosing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // Typing the address, not the word DELETE. It is the one string on screen
  // that is different for every person, so it cannot be muscle-memoried from
  // the last confirmation dialog they saw.
  const confirmed = !!email && typed.trim().toLowerCase() === email.toLowerCase();

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTyped("");
      setRefusal(null);
    }
  };

  const closeAccount = async () => {
    if (closing || !confirmed) return;
    setClosing(true);
    setRefusal(null);
    try {
      await api.account.close();
      // Signed out locally rather than left holding a token for a user that no
      // longer exists. Every subsequent request would 401 anyway; this makes
      // the screen agree with the database instead of failing its way there.
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch (e) {
      setRefusal(
        e instanceof ApiError
          ? e.message
          : "Couldn't close your account. Nothing has been deleted.",
      );
      setClosing(false);
    }
  };

  return (
    <section className="mt-16">
      <SectionHeading title="Closing your account" />
      <SectionCard className="mt-6 space-y-4">
        <p className="text-sm leading-[1.5] text-muted-foreground">
          This deletes your account and everything that belongs only to you — your conversations,
          your API keys, and any workspace you are the last person in. It cannot be undone.
        </p>
        <p className="text-sm leading-[1.5] text-muted-foreground">
          Workspaces you share with other people keep running without you. What you uploaded and
          what you wrote there stays, because it belongs to the workspace rather than to you; your
          name simply comes off it.
        </p>

        <div className="border-t border-hairline pt-4">
          <AlertDialog open={open} onOpenChange={reset}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-destructive hover:bg-destructive/10">
                Close my account
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  There is no undo and no grace period. Your conversations and API keys go, and any
                  workspace you are the last person in goes with them.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-2">
                <Label htmlFor="confirm-email">
                  Type <span className="font-mono text-foreground">{email ?? "your email"}</span> to
                  confirm
                </Label>
                <Input
                  id="confirm-email"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {refusal ? (
                // The 409 lands here. Nothing was deleted to produce it, so the
                // dialog stays open with the reason in it and the button still
                // available for after the person has fixed it.
                <p className="text-sm leading-[1.45] text-destructive">{refusal}</p>
              ) : null}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={closing}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // Kept open on purpose: the action would otherwise dismiss
                    // the dialog before the server has answered, and a refusal
                    // would have nowhere to be read.
                    e.preventDefault();
                    void closeAccount();
                  }}
                  disabled={!confirmed || closing}
                >
                  {closing ? "Closing…" : "Close my account"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SectionCard>
    </section>
  );
}
