import { useState } from "react";
import { Zap } from "lucide-react";
import { toast } from "sonner";
import { Chip, SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
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
  pending: "Setting up",
  active: "Listening",
  failed: "Not connected yet",
  expired: "Needs reconnecting",
  disabled: "Paused",
};

/**
 * What an event routine waits for, on the routine's own page (0109).
 *
 * Owner only, and that is the database's rule: the subscription row is shown
 * to the routine's owner and nobody else, so a colleague reading a shared
 * routine would get an empty card.
 */
export function RoutineEventCard({ routine }: { routine: Routine }) {
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
      if (updated.event?.status === "active") toast.success(`Listening to ${updated.event.app}`);
      else if (updated.event?.statusDetail) toast.message(updated.event.statusDetail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not set that up");
    }
  };

  const stop = async () => {
    try {
      await removeEvent.mutateAsync(routine.id);
      setChoice(null);
      setEditing(true);
      toast.success("Stopped listening");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not stop it");
    }
  };

  const test = async () => {
    try {
      const result = await testEvent.mutateAsync(routine.id);
      toast.success(
        result.status === "ok"
          ? "Test event sent — the result is in the run history"
          : result.status === "skipped"
            ? "The agent read the test event and found nothing to send"
            : result.status === "waiting"
              ? "Test running — the report is sent when the browser answers"
              : "The test run failed — see the run history",
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not send a test event");
    }
  };

  return (
    <section className="mt-10">
      <SectionHeading
        title="Starts when"
        description="Something happening in an app starts this routine, and the agent reads a short account of it."
      />

      <SectionCard className="mt-3 space-y-4">
        {editing ? (
          <>
            <EventPicker catalog={catalog} value={choice} onChange={setChoice} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!eventChoiceReady(catalog, choice) || setEvent.isPending}
              >
                {setEvent.isPending ? "Setting up…" : "Start listening"}
              </Button>
              {event && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
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
                <Chip tone={event.status === "active" ? "on" : "neutral"}>
                  {STATUS_WORD[event.status]}
                </Chip>
              </div>
              {event.statusDetail && (
                <p className="text-xs text-muted-foreground">{event.statusDetail}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {event.lastEventAt === null
                  ? "Nothing has arrived yet."
                  : `Last event ${formatRelative(event.lastEventAt)}.`}
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
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void test()}
                disabled={testEvent.isPending}
              >
                {testEvent.isPending ? "Running…" : "Send a test event"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {event.status === "expired" || event.status === "failed" ? "Reconnect" : "Change"}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={removeEvent.isPending}>
                    Stop listening
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Stop listening to {event.app}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Nothing will start this routine until you choose an event again. The routine
                      and its history stay.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void stop()}>
                      Stop listening
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </>
        ) : null}
      </SectionCard>
    </section>
  );
}
