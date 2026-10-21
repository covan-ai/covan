import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "@/components/avatars";
import { useAgentsStore } from "@/lib/agents-store";
import { canEditAgent } from "@/lib/agent-access";

/**
 * Which agents read a folder, from the workspace Knowledge page.
 *
 * Until this existed, a folder could be attached to an agent from exactly one
 * place: the Switch beside it on that agent's own Knowledge tab. The workspace
 * page — where files are uploaded — could only say "no agent reads this folder
 * yet" and point there. A tester uploaded a handbook, asked about it, was told
 * nothing was found, and spent a while looking for the screen that would have
 * explained why.
 *
 * The same Switch, the same words and the same rule as the agent tab: attaching
 * changes what an agent knows for everyone who uses it, so it takes Can edit on
 * the agent (0104), and the list is only the agents the person can edit.
 */
export function AttachBundleDialog({
  bundle,
  onOpenChange,
}: {
  /** The folder being attached, or null while the dialog is closed. */
  bundle: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const store = useAgentsStore();
  const editable = store.agents.filter(canEditAgent);

  return (
    <Dialog open={bundle !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach {bundle?.name}</DialogTitle>
          <DialogDescription>
            Agents read only the folders attached to them. Pick which should read this one.
          </DialogDescription>
        </DialogHeader>
        {bundle ? (
          editable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You can&apos;t edit any agent, so there is nothing to attach it to.
            </p>
          ) : (
            <ul className="-mx-1">
              {editable.map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-md px-1 py-2.5">
                  <AgentAvatar emoji={a.emoji} className="h-8 w-8 text-base" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.name}</span>
                  <Switch
                    checked={a.bundleIds.includes(bundle.id)}
                    onCheckedChange={(on) => {
                      if (on) void store.attachBundle(a.id, bundle.id);
                      else store.detachBundle(a.id, bundle.id);
                    }}
                    aria-label={`Attach ${bundle.name} to ${a.name}`}
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
