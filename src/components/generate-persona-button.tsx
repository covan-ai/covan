import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
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
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Drafts a persona / system prompt from the agent's title alone. Sits next to the
 * persona field on both the create dialog and the Configuration tab. Nothing is
 * saved here — the drafted text lands in the field and the user saves it (or not)
 * like anything else they typed, so a bad draft costs one undo, not a rollback.
 */
export function GeneratePersonaButton({
  name,
  model,
  hasPersona,
  onGenerated,
  className,
}: {
  name: string;
  model?: string;
  hasPersona: boolean;
  onGenerated: (persona: string) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const title = name.trim();

  const draft = async () => {
    if (!title || busy) return;
    setBusy(true);
    try {
      const { persona } = await api.persona.suggest(title, model);
      onGenerated(persona);
    } catch {
      toast.error("Couldn't write a persona. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-busy={busy}
        disabled={!title || busy}
        title={title ? undefined : "Name the agent first"}
        onClick={() => (hasPersona ? setConfirming(true) : void draft())}
        className={cn(
          "h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {busy ? "Writing…" : hasPersona ? "Rewrite from name" : "Write from name"}
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current persona?</AlertDialogTitle>
            <AlertDialogDescription>
              A new persona will be written from the name “{title}” and will overwrite what's in the
              field now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void draft()}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
