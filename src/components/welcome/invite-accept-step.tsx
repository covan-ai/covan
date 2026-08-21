import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Someone who was invited already has a workspace waiting, so the setup steps
 * would have them furnish one they abandon on accepting. This is what they get
 * instead — the invitation itself, at the moment it is relevant, rather than a
 * banner on a screen they have not learned to read yet.
 */
export function InviteAcceptStep({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  const [busy, setBusy] = useState(false);

  const accept = async (id: string) => {
    setBusy(true);
    try {
      await api.invitations.accept(id);
      // The same invalidation set IncomingInvitesBanner uses: accepting changes
      // which workspace the whole app is looking at.
      await Promise.all(
        [
          ["invitations", "incoming"],
          ["me"],
          ["workspaces"],
          ["agents"],
          ["sessions"],
          ["favorites"],
          ["messages"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      toast.success("You've joined the workspace");
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept the invite.");
      setBusy(false);
    }
  };

  if (incoming.length === 0) {
    // The invitation was accepted or revoked in another tab. Nothing to do here.
    return (
      <Button className="w-full" onClick={onDone}>
        Continue
      </Button>
    );
  }

  return (
    <div className="space-y-4">
      {incoming.map((invite) => (
        <div
          key={invite.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-card px-4 py-3.5"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 bg-accent-orange" />
          <span className="min-w-0 flex-1 text-[15px]">
            <strong className="font-medium">{invite.workspaceName}</strong>
            <span className="text-muted-foreground"> · as {invite.role}</span>
          </span>
          <Button size="sm" disabled={busy} onClick={() => void accept(invite.id)}>
            Join
          </Button>
        </div>
      ))}
      <button
        type="button"
        onClick={onDone}
        className="w-full text-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Not now
      </button>
    </div>
  );
}
