import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { OPEN_THE_EMAIL, useAcceptInvitation } from "@/lib/accept-invitation";

/**
 * Someone who was invited already has a workspace waiting, so the setup steps
 * would have them furnish one they abandon on accepting. This is what they get
 * instead — the invitation itself, at the moment it is relevant, rather than a
 * banner on a screen they have not learned to read yet.
 */
export function InviteAcceptStep({ onDone }: { onDone: () => void }) {
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  // The same accept the banner over the app uses, token and all: the two used
  // to be hand-written copies, and drifted.
  const { accept, canAccept, busy } = useAcceptInvitation();

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
          <span className="min-w-0 flex-1 text-base">
            <strong className="font-medium">{invite.workspaceName}</strong>
            <span className="text-muted-foreground"> · as {invite.role}</span>
          </span>
          {canAccept(invite.id) ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void accept(invite.id).then((joined) => joined && onDone())}
            >
              Join
            </Button>
          ) : (
            <span className="text-meta text-muted-foreground">{OPEN_THE_EMAIL}</span>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={onDone}
        className="w-full text-center text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Not now
      </button>
    </div>
  );
}
