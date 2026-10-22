import { AgentMark } from "@/components/agent-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useAgentsStore } from "@/lib/agents-store";
import { canEditAgent } from "@/lib/agent-access";
import { formatFileSize } from "@/lib/file-size";

/**
 * "Who reads Contracts" (A25): every agent the caller may edit, with a switch
 * for whether it reads this folder. Each switch saves as it moves; Done
 * closes. An agent sees new files within a minute, and nothing about the
 * folder moves or is sent anywhere.
 */
export function FolderReadersDialog({
  bundle,
  onOpenChange,
  summary,
}: {
  /** The folder, or null while the dialog is closed. */
  bundle: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** For the footer: "18 files · 42 MB". */
  summary?: { files: number; bytes: number };
}) {
  const store = useAgentsStore();
  const editable = store.agents.filter(canEditAgent);

  return (
    <Dialog open={bundle !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Who reads {bundle?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="m-0 text-meta text-muted-foreground">
            An agent sees new files in this folder within a minute. Nothing is sent anywhere; the
            folder stays where it is.
          </p>
          {bundle ? (
            editable.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                You can&apos;t edit any agent, so there is nothing to give it to.
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {editable.map((a) => (
                  <li
                    key={a.id}
                    className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-b-0"
                  >
                    <AgentMark agent={a} size={24} />
                    <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                    <Switch
                      checked={a.bundleIds.includes(bundle.id)}
                      onCheckedChange={(on) => {
                        if (on) void store.attachBundle(a.id, bundle.id);
                        else store.detachBundle(a.id, bundle.id);
                      }}
                      aria-label={`${a.name} reads ${bundle.name}`}
                    />
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </DialogBody>
        <DialogFooter>
          {summary ? (
            <span className="mr-auto text-meta text-muted-foreground">
              {summary.files} {summary.files === 1 ? "file" : "files"} ·{" "}
              {formatFileSize(summary.bytes)}
            </span>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
