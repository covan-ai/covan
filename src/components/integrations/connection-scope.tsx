import { toast } from "sonner";
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
  const update = useUpdateToolConnection();
  const shared = connection.scope === "workspace";

  const toggle = () =>
    update.mutate(
      { id: connection.id, patch: { shared: !shared } },
      {
        onSuccess: () =>
          toast.success(
            shared
              ? `${connection.label} is yours alone again.`
              : `${connection.label} is shared with the workspace.`,
          ),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Could not change who can use it"),
      },
    );

  return (
    <>
      <Chip tone="neutral">{shared ? "Shared" : connection.mine ? "Only you" : "Personal"}</Chip>
      {connection.mine ? (
        <Button variant="ghost" size="sm" onClick={toggle} disabled={update.isPending}>
          {update.isPending ? "Saving…" : shared ? "Stop sharing" : "Share"}
        </Button>
      ) : null}
    </>
  );
}
