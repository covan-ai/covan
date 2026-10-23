import { useState } from "react";
import { Zap } from "lucide-react";
import { toast } from "sonner";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Chip } from "@/components/chip";
import { SectionLabel } from "@/components/section";
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
import { EventPicker } from "@/components/routines/event-picker";
import { GitHubWebhookSetup } from "@/components/routines/github-webhook-setup";
import { EmailAddressSetup } from "@/components/routines/email-address-setup";
import { TelegramBotSetup } from "@/components/routines/telegram-bot-setup";
import { eventChoiceReady } from "@/lib/event-choice";
import { ApiError } from "@/lib/api-client";
import { formatRelative } from "@/lib/relative-time";
import {
  useEventCatalog,
  useRemoveRoutineEvent,
  useSetRoutineEvent,
  useTestRoutineEvent,
} from "@/hooks/use-routines";
import type { EventChoice, Routine, RoutineEventStatus } from "@/lib/routines-api";

/**
 * How the arrangement with the app stands, in a word. Amber only for the one
 * state that means "listening" — the palette's single pointer — and neutral
 * for everything else, including the faults: their sentence, below the chip,
 * is what the owner acts on, and a red chip would be a second accent.
 */
const STATUS_WORD: Record<RoutineEventStatus, string> = {
  pending: msg("Setting up"),
  active: msg("Listening"),
  failed: msg("Not connected yet"),
  expired: msg("Needs reconnecting"),
  disabled: msg("Paused"),
};

/**
 * What an event routine waits for, on the routine's own page (0109).
 *
 * Owner only, and that is the database's rule: the subscription row is shown
 * to the routine's owner and nobody else, so a colleague reading a shared
 * routine would get an empty card.
 */
export function RoutineEventCard({ routine }: { routine: Routine }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const event = routine.event;
  const [editing, setEditing] = useState(event === null);
  const [choice, setChoice] = useState<EventChoice | null>(
    event ? { type: event.type, config: event.config } : null,
  );
  const { data: catalog = [] } = useEventCatalog(editing);
  const setEvent = useSetRoutineEvent();
  const removeEvent = useRemoveRoutineEvent();
  const testEvent = useTestRoutineEvent();

  const save = async () => {
    if (!choice) return;
    try {
      const updated = await setEvent.mutateAsync({ id: routine.id, choice });
      setEditing(false);
      if (updated.event?.status === "active")
        toast.success(t("Listening to {{app}}", { app: updated.event.app }));
      else if (updated.event?.statusDetail) toast.message(updated.event.statusDetail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not set that up"));
    }
  };

  const stop = async () => {
    try {
      await removeEvent.mutateAsync(routine.id);
      setChoice(null);
      setEditing(true);
      toast.success(t("Stopped listening"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not stop it"));
    }
  };

  const test = async () => {
    try {
      const result = await testEvent.mutateAsync(routine.id);
      toast.success(
        result.status === "ok"
          ? t("Test event sent — the result is in the run history")
          : result.status === "skipped"
            ? t("The agent read the test event and found nothing to send")
            : result.status === "waiting"
              ? t("Test running — the report is sent when the browser answers")
              : t("The test run failed — see the run history"),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not send a test event"));
    }
  };

  return (
    <section className="mt-2">
      <SectionLabel>{t("Starts when")}</SectionLabel>
      <p className="mt-0 mb-3 text-meta text-muted-foreground">
        {t(
          "Something happening in an app starts this routine, and the agent reads a short account of it.",
        )}
      </p>

      <div className="space-y-4">
        {editing ? (
          <>
            <EventPicker catalog={catalog} value={choice} onChange={setChoice} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!eventChoiceReady(catalog, choice) || setEvent.isPending}
              >
                {setEvent.isPending ? t("Setting up…") : t("Start listening")}
              </Button>
              {event && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  {t("Cancel")}
                </Button>
              )}
            </div>
          </>
        ) : event ? (
          <>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Zap className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  {event.app} · {event.label}
                </span>
                <Chip tone={event.status === "active" ? "ink" : "neutral"}>
                  {lookup(t, STATUS_WORD[event.status])}
                </Chip>
              </div>
              {event.statusDetail && (
                <p className="text-meta text-muted-foreground">{event.statusDetail}</p>
              )}
              <p className="text-meta text-muted-foreground">
                {event.lastEventAt === null
                  ? t("Nothing has arrived yet.")
                  : t("Last event {{when}}.", {
                      when: formatRelative(event.lastEventAt, undefined, t, locale),
                    })}
              </p>
            </div>
            {event.provider === "github" && (
              <GitHubWebhookSetup routineId={routine.id} eventType={event.type} />
            )}
            {event.provider === "email" && (
              <EmailAddressSetup
                routineId={routine.id}
                senders={typeof event.config.senders === "string" ? event.config.senders : null}
              />
            )}
            {event.provider === "telegram" && event.status === "active" && (
              <TelegramBotSetup routineId={routine.id} />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void test()}
                disabled={testEvent.isPending}
              >
                {testEvent.isPending ? t("Running…") : t("Send a test event")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                {event.status === "expired" || event.status === "failed"
                  ? t("Reconnect")
                  : t("Change")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={removeEvent.isPending}>
                    {t("Stop listening")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("Stop listening to {{app}}?", { app: event.app })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        "Nothing will start this routine until you choose an event again. The routine and its history stay.",
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void stop()}>
                      {t("Stop listening")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
