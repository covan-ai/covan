import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QuotaSupportForm } from "@/components/quota-support-form";
import { api } from "@/lib/api-client";
import { isAdminRole } from "@/lib/roles";
import { adminsToAsk } from "@/lib/admins-to-ask";

/**
 * What sits where the reply would have been, when the workspace had no
 * credits to pay for it.
 *
 * The message is saved; only the reply was refused. A toast saying so was gone
 * in four seconds and left a question with nothing under it, which looks
 * exactly like one still being answered. This stays, and says the next step
 * for the person reading it: an admin can ask us for credits right here (the
 * same form as the usage page's wall), anybody else is told which admin to
 * ask. Try again waits for the balance to come back rather than offering a
 * button that would be refused the same way.
 */
export function OutOfCreditsNote({
  canRetry,
  onRetry,
}: {
  /** Whether credits have come back since the refusal. */
  canRetry: boolean;
  /** Absent when the reader may not ask this conversation for a reply. */
  onRetry?: () => void;
}) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const [asking, setAsking] = useState(false);
  // The house pattern for the caller's role (`lib/workspace-role.ts`), read
  // defensively: this renders inside a conversation, and a `me` without its
  // member list must cost the person a name, not the transcript.
  const members = me?.members ?? [];
  const isAdmin = isAdminRole(members.find((m) => m.id === me?.user.id)?.role);
  const admins = adminsToAsk(members, me?.user.id);

  return (
    <div
      role="status"
      className="mt-5 flex flex-col gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-brand" />
        <span className="min-w-0 flex-1">
          {canRetry
            ? "Credits are back. This message has no reply yet."
            : "This workspace is out of credits, so this message has no reply yet."}
        </span>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry} disabled={!canRetry}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        )}
      </div>
      {!canRetry && (
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          {isAdmin ? (
            <p>Top-ups are handled by hand for now — tell us how many credits you need.</p>
          ) : (
            <p>
              {admins
                ? `Ask ${admins}, an admin of this workspace, to add credits.`
                : "Ask an admin of this workspace to add credits."}{" "}
              Replies start again as soon as they do.
            </p>
          )}
          {isAdmin || asking ? (
            <QuotaSupportForm />
          ) : (
            <button
              type="button"
              onClick={() => setAsking(true)}
              className="self-start text-xs text-foreground underline-offset-4 hover:underline"
            >
              Or message Covan
            </button>
          )}
        </div>
      )}
    </div>
  );
}
