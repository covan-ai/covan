import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { OPEN_THE_EMAIL, useAcceptInvitation } from "@/lib/accept-invitation";

export function IncomingInvitesBanner() {
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  const { accept, canAccept, busy } = useAcceptInvitation();

  if (incoming.length === 0) return null;

  return (
    <div className="border-b border-border bg-surface">
      {incoming.map((inv) => (
        <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
          <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm">
            You've been invited to <strong>{inv.workspaceName}</strong> as {inv.role}.
          </span>
          {/* Accepting takes the token from the invitation's email. Without it
              in this browser a button would only ever be refused, so the
              banner says where the way in is instead. */}
          {canAccept(inv.id) ? (
            <Button
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={() => void accept(inv.id)}
            >
              Accept
            </Button>
          ) : (
            <span className="ml-auto text-meta text-muted-foreground">{OPEN_THE_EMAIL}</span>
          )}
        </div>
      ))}
    </div>
  );
}
