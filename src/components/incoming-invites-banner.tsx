import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { toast } from "sonner";

export function IncomingInvitesBanner() {
  const queryClient = useQueryClient();
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });

  const accept = async (id: string) => {
    try {
      await api.invitations.accept(id);
      // Accepting changes which workspace the whole app is looking at, so it
      // invalidates exactly what switching workspaces does — including the
      // incoming invitations themselves, which `invitations` prefix-matches.
      // This was a hand-written list until it had silently drifted four keys
      // from the real one.
      await invalidateWorkspaceScoped(queryClient);
      toast.success("You've joined the workspace");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept invite");
    }
  };

  if (incoming.length === 0) return null;

  return (
    <div className="border-b border-border bg-surface">
      {incoming.map((inv) => (
        <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm">
            You've been invited to <strong>{inv.workspaceName}</strong> as {inv.role}.
          </span>
          <Button size="sm" className="ml-auto" onClick={() => accept(inv.id)}>
            Accept
          </Button>
        </div>
      ))}
    </div>
  );
}
