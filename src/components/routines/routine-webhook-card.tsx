import { useState } from "react";
import { Webhook } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
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
import { ApiError } from "@/lib/api-client";
import {
  useRoutineTrigger,
  useCreateRoutineTrigger,
  useRemoveRoutineTrigger,
} from "@/hooks/use-routines";

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
      toast.error(err instanceof ApiError ? err.message : "Could not create that URL");
    }
  };

  const turnOff = async () => {
    try {
      await remove.mutateAsync(routineId);
      setRevealed(null);
      toast.success("Webhook turned off");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not turn it off");
    }
  };

  const configured = trigger?.configured === true;

  return (
    <section className="mt-10">
      <SectionHeading
        title="Webhook"
        description="The URL that starts this routine. Whatever it POSTs is what the agent reads."
      />

      <SectionCard className="mt-3 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : revealed ? (
          <div className="space-y-3">
            <RevealedSecret value={revealed} label="Copy webhook URL" />
            <p className="text-xs text-muted-foreground">
              This is the only time it is shown. Covan stores a hash of it, so nobody — including us
              — can show it again. Anyone who has this URL can start this routine, which spends your
              allowance, so treat it the way you would a password. Lost it? Make a new one here; the
              old one stops working at once.
            </p>
          </div>
        ) : configured ? (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm">
              <Webhook className="h-4 w-4 shrink-0 text-muted-foreground" />
              This routine has a webhook URL.
            </p>
            <p className="text-xs text-muted-foreground">
              {trigger.lastUsedAt === null
                ? "Nothing has used it yet."
                : `Last used ${formatWhen(trigger.lastUsedAt)}.`}{" "}
              The URL itself is not shown again.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No webhook URL yet. Make one and paste it into whatever should start this routine.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {configured ? (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={create.isPending}>
                    Replace the URL
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Replace this webhook URL?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The current URL stops working the moment you confirm, and anything still
                      calling it will get a 401 until you paste the new one in. The routine itself
                      is unchanged.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void mint()}>Replace</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={remove.isPending}>
                    Turn it off
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Turn this webhook off?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The URL stops working and nothing can start this routine from outside. If it
                      also runs on a schedule, it keeps doing that.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void turnOff()}>Turn off</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <Button size="sm" onClick={() => void mint()} disabled={create.isPending}>
              {create.isPending ? "Making…" : "Make a webhook URL"}
            </Button>
          )}
        </div>
      </SectionCard>
    </section>
  );
}
