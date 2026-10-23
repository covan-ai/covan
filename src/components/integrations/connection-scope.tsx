import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/chip";
import { useUpdateToolConnection } from "@/hooks/use-connections";
import type { ToolConnection } from "@/lib/connections-api";

/**
 * Who may use a connection, and — for the person who made it — the switch.
 *
 * A connection is personal unless its maker shares it (migration 0098): their
 * Gmail is their agents' tool, not every member's. Sharing it makes it every
 * member's, and anybody else's turn that writes through it asks first. Only
 * the person who connected it sees the button: nobody else can share
 * somebody's account, and an admin's answer to a shared one they do not want
 * is Remove.
 *
 * A chip, neutral, in words — never amber: who can use a thing is a fact
 * about it, not a pointer (DESIGN.md).
 */
export function ConnectionScope({ connection }: { connection: ToolConnection }) {
  const { t } = useTranslation();
  const update = useUpdateToolConnection();
  const shared = connection.scope === "workspace";

  const toggle = () =>
    update.mutate(
      { id: connection.id, patch: { shared: !shared } },
      {
        onSuccess: () =>
          toast.success(
            shared
              ? t("{{app}} is yours alone again.", { app: connection.label })
              : t("{{app}} is shared with the workspace.", { app: connection.label }),
          ),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : t("Could not change who can use it")),
      },
    );

  return (
    <>
      <Chip tone="neutral">
        {shared ? t("Shared") : connection.mine ? t("Only you") : t("Personal")}
      </Chip>
      {connection.mine ? (
        <Button variant="ghost" size="sm" onClick={toggle} disabled={update.isPending}>
          {update.isPending ? t("Saving…") : shared ? t("Stop sharing") : t("Share")}
        </Button>
      ) : null}
    </>
  );
}
