import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { OpenBrowsersList } from "@/components/open-browsers";
import { SavedLoginsList } from "@/components/saved-logins";
import { api, ApiError } from "@/lib/api-client";

/**
 * The sign-ins a browser task is carrying, and the way to end them.
 *
 * Spec §7a. A browser task that stopped at a login wall is recoverable by
 * signing in yourself, and what survives that is a cookie jar held at
 * browser-use — so this feature accumulates logins by design. Closing the
 * account already deleted them (`routes/account.ts`), and that is not the same
 * right: "stop holding my logins" must not cost somebody their account.
 *
 * What the screen can show is exactly `cookie_domains`, which is also the only
 * column of that row 0077 lets a client read at all. The cookies are at the
 * provider and the address of them — `provider_profile_id` — is granted to no
 * client role, so there is nothing here to render that could be screenshotted
 * into a ticket.
 *
 * **No confirmation typing, unlike closing the account.** Deliberate, and the
 * asymmetry is the point: this is destructive but not irreversible in the way
 * that matters — the person can sign in again, by hand, the next time a task
 * needs it. Making them type an address to drop a cookie jar would price the
 * safe action like the unsafe one, and the predictable result is that nobody
 * uses it.
 *
 * **And the logins a person chose to save (Task 2.4)**, which are a different
 * thing and get their own section: a username and password kept, encrypted,
 * for one agent, because somebody pressed Save on the sign-in card. Their own
 * and the shared ones they can see — label, site, who it is for, last used,
 * Forget — never a username (`SavedLoginsList`). Each section draws only when
 * it has something to show.
 *
 * **And the browsers of theirs that may still be open (Task 3.2, ruling
 * R48)**, each with the way to end it that already exists: the panel's close,
 * or the takeover's Done (`OpenBrowsersList`). Directly under the sign-ins
 * rather than last, because the two are one subject: stopping a browser is
 * what saves what was signed in there, and an open one is what Forget refuses
 * on — the person who meets that refusal finds the browser just below it.
 */
export function BrowserSignInsSection() {
  return (
    <>
      <CookieJarSection />
      <OpenBrowsersList
        wrap={(list) => (
          <section className="mt-16">
            <SectionHeading
              title="Open browsers"
              description="Browsers of yours that may still be open. Stopping one saves its sign-ins; none is stopped while the agent is using it."
            />
            <SectionCard className="mt-6">{list}</SectionCard>
          </section>
        )}
      />
      <SavedLoginsList
        wrap={(list) => (
          <section className="mt-16">
            <SectionHeading
              title="Saved logins"
              description="Logins you saved for an agent, and the ones your team saved for everyone using one. Encrypted; Covan's AI model is never given them."
            />
            <SectionCard className="mt-6">{list}</SectionCard>
          </section>
        )}
      />
    </>
  );
}

function CookieJarSection() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["browser-profile"],
    queryFn: () => api.browser.profile(),
  });

  const forget = useMutation({
    mutationFn: () => api.browser.forget(),
    onSuccess: async () => {
      setOpen(false);
      setRefusal(null);
      await queryClient.invalidateQueries({ queryKey: ["browser-profile"] });
    },
    onError: (e: unknown) => {
      // The 409 lands here: a browser of theirs is open, and the dialog stays
      // up with the reason in it, because it is an instruction about what to do
      // next rather than a notification that something happened. Same
      // judgement `close-account-section.tsx` makes about its own refusal.
      setRefusal(
        e instanceof ApiError ? e.message : "Couldn't forget those sign-ins. Nothing was deleted.",
      );
    },
  });

  // Nothing held is not an empty state to apologise for — it is the ordinary
  // one, and a section about forgetting logins that do not exist is noise on a
  // page that already has eight of them.
  const sites = data?.profile?.cookieDomains ?? [];
  if (isLoading || !data?.profile) return null;

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) setRefusal(null);
  };

  return (
    <section className="mt-16">
      <SectionHeading title="Browser sign-ins" />
      <SectionCard className="mt-6 space-y-4">
        <p className="text-sm leading-[1.5] text-muted-foreground">
          When a browser task stops at a login, you can sign in yourself in your own tab. What
          survives that is a cookie jar held by our browser provider, so the next task does not ask
          again. <strong>Covan never receives your password</strong> — you type it at the site, and
          this is the whole of what signing in yourself keeps.
        </p>

        {sites.length > 0 ? (
          <div>
            {/* NOT "signed in to", which is what this said until the first real
                run: one hand-performed LinkedIn sign-in left seven domains, and
                five of them — facebook.com, google.com, demdex.net,
                33across.com, protechts.net — were ad-tech cookies the page
                dropped on the way. Telling somebody they are signed in to
                Facebook because they logged into LinkedIn is false, and
                frightening in a way the truth is not. */}
            <p className="text-sm leading-[1.5] text-muted-foreground">
              Cookies are held for these sites. Most pages drop cookies for other companies as they
              load, so this list is longer than the places you actually signed in to:
            </p>
            <ul className="mt-2 space-y-1">
              {sites.map((site) => (
                <li key={site} className="font-mono text-sm text-foreground">
                  {site}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          // A row with no domains is a real state, not a loading one: a profile
          // is created the first time a browser needs one, and the list is
          // filled in when a stop has saved something into it. Not "nothing
          // saved": on 2026-10-11 the provider saved a jar on a stop and never
          // reported it, so an empty list can sit beside a jar that holds
          // cookies — which is also why Forget is offered either way.
          <p className="text-sm leading-[1.5] text-muted-foreground">
            No sites are listed yet. The list fills in after a browser of yours stops, and can lag
            behind it.
          </p>
        )}

        <div className="border-t border-hairline pt-4">
          <AlertDialog open={open} onOpenChange={reset}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-destructive hover:bg-destructive/10">
                Forget these sign-ins
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Forget your browser sign-ins?</AlertDialogTitle>
                <AlertDialogDescription>
                  The cookie jar is deleted at our browser provider. A task behind a login will stop
                  at the login again, and you can sign in yourself when it does.
                </AlertDialogDescription>
              </AlertDialogHeader>

              {refusal ? (
                <p className="text-sm leading-[1.45] text-destructive">{refusal}</p>
              ) : null}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={forget.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // Kept open so a refusal has somewhere to be read, exactly
                    // as the account dialog does it.
                    e.preventDefault();
                    forget.mutate();
                  }}
                  disabled={forget.isPending}
                >
                  {forget.isPending ? "Forgetting…" : "Forget them"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SectionCard>
    </section>
  );
}
