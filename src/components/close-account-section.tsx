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
import { Trans, useTranslation } from "@/i18n";
import { Field } from "@/components/field";
import { SectionLabel } from "@/components/section";
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [closing, setClosing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // Typing the address, not the word DELETE. It is the one string on screen
  // that is different for every person, so it cannot be muscle-memoried from
  // the last confirmation dialog they saw.
  // An address, compared as the API stores it: ASCII-folded. i18n-ignore
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
          : t("Couldn't close your account. Nothing has been deleted."),
      );
      setClosing(false);
    }
  };

  // A16's Danger: one field, the consequences in its help and under it.
  return (
    <>
      <SectionLabel>{t("Danger")}</SectionLabel>
      <Field
        label={t("Close account")}
        help={t(
          "Leaves every workspace. What you made in a shared one stays with it, without your name.",
        )}
      >
        <div className="flex max-w-[560px] flex-col gap-2">
          <p className="m-0 text-meta leading-[1.5] text-muted-foreground">
            {t(
              "This deletes your account and everything that belongs only to you — your conversations, your API keys, and any workspace you are the last person in. It cannot be undone.",
            )}
          </p>
          <p className="m-0 text-meta leading-[1.5] text-muted-foreground">
            {t(
              "Workspaces you share with other people keep running without you. What you uploaded and what you wrote there stays, because it belongs to the workspace rather than to you; your name simply comes off it.",
            )}
          </p>
          {/* The way out of the paragraph above, and it has to be here rather than
            only on /privacy — this is the screen where somebody decides, and a
            page they would have to already be reading is not where you put the
            one thing that has to happen first. Deliberately not a button: a
            document that has been indexed is what other people's answers are
            grounded on, and "delete the 14 files you uploaded" on the way out
            is a way to damage a team. Asking puts a person in the loop, which
            is the right amount of friction for something irreversible that
            affects somebody other than the asker. See covan#56. */}
          <p className="m-0 text-meta leading-[1.5] text-muted-foreground">
            {t(
              "If you want a file you uploaded removed rather than anonymous, ask before you close, not after — once the account is gone there is nothing left to tell which files were yours.",
            )}
          </p>

          <div className="pt-1">
            <AlertDialog open={open} onOpenChange={reset}>
              <AlertDialogTrigger asChild>
                <Button variant="danger">{t("Close my account")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Close your account?")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t(
                      "There is no undo and no grace period. Your conversations and API keys go, and any workspace you are the last person in goes with them.",
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="space-y-2">
                  <Label htmlFor="confirm-email">
                    <Trans
                      t={t}
                      i18nKey="Type <code>{{email}}</code> to confirm"
                      values={{ email: email ?? t("your email") }}
                      components={{ code: <span className="font-mono text-foreground" /> }}
                    />
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
                  <AlertDialogCancel disabled={closing}>{t("Cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      // Kept open on purpose: the action would otherwise dismiss
                      // the dialog before the server has answered, and a refusal
                      // would have nowhere to be read.
                      e.preventDefault();
                      void closeAccount();
                    }}
                    variant="danger"
                    disabled={!confirmed || closing}
                  >
                    {closing ? t("Closing…") : t("Close my account")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </Field>
    </>
  );
}
