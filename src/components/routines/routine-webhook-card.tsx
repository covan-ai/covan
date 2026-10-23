import { useState } from "react";
import { Webhook } from "lucide-react";
import { SectionLabel } from "@/components/section";
import { RevealedSecret } from "@/components/revealed-secret";
import { Button } from "@/components/ui/button";
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
import { toast } from "sonner";
import { Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { ApiError } from "@/lib/api-client";
import {
  useRoutineTrigger,
  useCreateRoutineTrigger,
  useRemoveRoutineTrigger,
} from "@/hooks/use-routines";

function formatWhen(epochMs: number, locale: string): string {
  return new Date(epochMs).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The URL that starts this routine, on the routine's own page.
 *
 * Owner only, and that is the database's rule rather than this component's:
 * `routine_triggers_select_own` returns the row to the routine's owner and to
 * nobody else, deliberately narrower than the routine's own visibility.
 * Sharing a routine shares what it does and what it sent — not the ability to
 * fire it.
 */
export function RoutineWebhookCard({ routineId }: { routineId: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data: trigger, isLoading } = useRoutineTrigger(routineId, true);
  const create = useCreateRoutineTrigger();
  const remove = useRemoveRoutineTrigger();

  /**
   * The full URL, for as long as it is on screen. Held here rather than
   * fetched, because this is the only moment it exists outside the database —
   * the server keeps a SHA-256 and cannot show it again.
   */
  const [revealed, setRevealed] = useState<string | null>(null);

  const mint = async () => {
    try {
      const { path } = await create.mutateAsync(routineId);
      setRevealed(`${import.meta.env.VITE_API_URL}${path}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not create that URL"));
    }
  };

  const turnOff = async () => {
    try {
      await remove.mutateAsync(routineId);
      setRevealed(null);
      toast.success(t("Webhook turned off"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not turn it off"));
    }
  };

  const configured = trigger?.configured === true;

  return (
    <section className="mt-2">
      <SectionLabel>{t("Webhook")}</SectionLabel>
      <p className="mt-0 mb-3 text-meta text-muted-foreground">
        {t("The URL that starts this routine. Whatever it POSTs is what the agent reads.")}
      </p>

      <div className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
        ) : revealed ? (
          <div className="space-y-3">
            <RevealedSecret value={revealed} label={t("Copy webhook URL")} />
            <p className="text-meta text-muted-foreground">
              {t(
                "This is the only time it is shown. Covan stores a hash of it, so nobody — including us — can show it again. Anyone who has this URL can start this routine, which spends your workspace's credits, so treat it the way you would a password. Lost it? Make a new one here; the old one stops working at once.",
              )}
            </p>
          </div>
        ) : configured ? (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm">
              <Webhook className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("This routine has a webhook URL.")}
            </p>
            <p className="text-meta text-muted-foreground">
              {trigger.lastUsedAt === null
                ? t("Nothing has used it yet.")
                : t("Last used {{when}}.", { when: formatWhen(trigger.lastUsedAt, locale) })}{" "}
              {t("The URL itself is not shown again.")}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              "No webhook URL yet. Make one and paste it into whatever should start this routine.",
            )}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {configured ? (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="secondary" size="sm" disabled={create.isPending}>
                    {t("Replace the URL")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("Replace this webhook URL?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        "The current URL stops working the moment you confirm, and anything still calling it will get a 401 until you paste the new one in. The routine itself is unchanged.",
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void mint()}>
                      {t("Replace")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={remove.isPending}>
                    {t("Turn it off")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("Turn this webhook off?")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        "The URL stops working and nothing can start this routine from outside. If it also runs on a schedule, it keeps doing that.",
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void turnOff()}>
                      {t("Turn off")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <Button size="sm" onClick={() => void mint()} disabled={create.isPending}>
              {create.isPending ? t("Making…") : t("Make a webhook URL")}
            </Button>
          )}
        </div>

        {(configured || revealed) && <SiriSteps />}
      </div>
    </section>
  );
}

/**
 * Starting the routine from Siri or the Shortcuts app, with nothing but this
 * URL. `?wait=1` makes the webhook hold its answer until the run is done (up
 * to about 25 seconds) and put the report in `summary`, which the shortcut
 * reads out; a longer run still says something there, and its report goes to
 * the delivery channel as always.
 *
 * Behind a disclosure, because most people with a webhook are pasting it into
 * GitHub or a CI job, and these steps are for the few on a phone.
 */
function SiriSteps() {
  const { t } = useTranslation();
  const code = <code className="font-mono" />;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t("Use it with Siri or Shortcuts")}
      </summary>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
        <li>{t("In the Shortcuts app, make a new shortcut and add Dictate Text.")}</li>
        <li>
          <Trans
            t={t}
            i18nKey="Add Get Contents of URL. Paste this webhook URL and add <code>?wait=1</code> to the end. Set Method to POST and Request Body to JSON, with one Text field named <code>text</code> set to Dictated Text."
            components={{ code }}
          />
        </li>
        <li>
          <Trans
            t={t}
            i18nKey="Add Get Dictionary Value for the key <code>summary</code>, then Speak Text."
            components={{ code }}
          />
        </li>
        <li>{t("Name the shortcut. Saying “Hey Siri” and its name runs it.")}</li>
      </ol>
      <p className="mt-2 text-meta text-muted-foreground">
        <Trans
          t={t}
          i18nKey="Siri reads the routine's answer if it is ready within about 25 seconds. If not, it says the routine is still working, and the answer arrives where this routine delivers. To keep the token out of the URL, replace the token at its end with <code>-</code> and send the token in an <code>X-Covan-Ingest-Token</code> header instead."
          components={{ code }}
        />
      </p>
    </details>
  );
}
