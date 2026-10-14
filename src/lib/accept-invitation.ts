import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { forgetInvite, stashedInviteToken } from "@/lib/invite-stash";

/**
 * Accepting an invitation, for the two places that offer it: the banner over
 * the app and the first-run step.
 *
 * Both need the token the invitation's email carried (migration 0090), which
 * `/invite` keeps in this browser. An invitation listed without one is real
 * and addressed to this account, but accepting it needs the email — so
 * `canAccept` is what decides whether a button is offered at all, rather than
 * offering one that is certain to be refused.
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const canAccept = (id: string): boolean => stashedInviteToken(id) !== null;

  /** True once joined. Says what went wrong itself, so callers need not. */
  const accept = async (id: string): Promise<boolean> => {
    const token = stashedInviteToken(id);
    if (!token) return false;
    setBusy(true);
    try {
      await api.invitations.accept(id, token);
      forgetInvite(id);
      // Accepting changes which workspace the whole app is looking at, so it
      // invalidates exactly what switching workspaces does — including the
      // incoming invitations themselves, which `invitations` prefix-matches.
      await invalidateWorkspaceScoped(queryClient);
      toast.success("You've joined the workspace");
      return true;
    } catch (e) {
      // A refused token is spent, expired or replaced by a newer link; holding
      // on to it would only offer the same refusal again.
      if (e instanceof ApiError && e.status === 400) forgetInvite(id);
      toast.error(e instanceof ApiError ? e.message : "Couldn't accept the invitation.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { accept, canAccept, busy };
}

/** What to say where an Accept button would be, when there is no token. */
export const OPEN_THE_EMAIL = "Open the link in your invitation email to accept.";
