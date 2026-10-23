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
import { useTranslation } from "@/i18n";
import { useAgentsStore, type Agent } from "@/lib/agents-store";

/**
 * "Attach folder" in an agent's Configuration (A10): the other side of "Who
 * reads Contracts" — every folder in the workspace, with a switch for whether
 * this agent reads it. Each switch saves as it moves.
 */
export function AgentFoldersDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const store = useAgentsStore();
  const folders = store.bundles;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("Folders {{agent}} reads", { agent: agent.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="m-0 text-meta text-muted-foreground">
            {t(
              "Everything in a folder, including what a connected source syncs into it. New files are read within a minute.",
            )}
          </p>
          {folders.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              {t("No folders yet. Make one in Knowledge.")}
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {folders.map((b) => (
                <li
                  key={b.id}
                  className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                  <span className="text-meta text-muted-foreground tabular-nums">
                    {t("{{count}} file", {
                      count: b.documentCount,
                      defaultValue_other: "{{count}} files",
                    })}
                  </span>
                  <Switch
                    checked={agent.bundleIds.includes(b.id)}
                    onCheckedChange={(on) => {
                      if (on) void store.attachBundle(agent.id, b.id);
                      else store.detachBundle(agent.id, b.id);
                    }}
                    aria-label={t("{{agent}} reads {{folder}}", {
                      agent: agent.name,
                      folder: b.name,
                    })}
                  />
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            {t("Done", { context: "button", defaultValue: "Done" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
