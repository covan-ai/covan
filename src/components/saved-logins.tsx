import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Chip } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { api, type SavedLogin } from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";

/**
 * Saved logins (0079, Task 2.4): the list on a person's settings and on an
 * agent's.
 *
 * **Label, host, scope, last used, Forget — never a username.** The server has
 * no plaintext to send and grants neither ciphertext to anybody, and this list
 * draws named fields only, so a field that should never be here is not drawn
 * even if a response ever carried one. Not the saver either: a shared login
 * says who it is for, and `own` is all a screen needs about who saved it.
 *
 * **Forget only where it would be allowed** — the person's own, or a shared
 * one when they are an admin of its workspace (R29) — read off `canForget`,
 * which the server computes by the same rule it enforces. The DELETE decides
 * again, and its refusal is shown as it is.
 */

/** Under one prefix, so a forget or a save refreshes every list on screen. */
const savedLoginsKey = (agentId?: string) => ["browser-credentials", agentId ?? "all"] as const;

function lastUsed(at: string | null): string {
  if (!at) return "Not used yet";
  return `Last used ${new Date(at).toLocaleDateString()}`;
}

export function SavedLoginsList({
  agentId,
  empty,
  wrap,
}: {
  /** One agent's logins; omitted, every login the caller can see. */
  agentId?: string;
  /** What to say when there are none; omitted, the list renders nothing then. */
  empty?: string;
  /** The frame around the list — a settings section — drawn only when there is a list to frame. */
  wrap?: (list: ReactElement) => ReactElement;
}) {
  const queryClient = useQueryClient();
  const [forgetting, setForgetting] = useState<SavedLogin | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: savedLoginsKey(agentId),
    queryFn: () => api.browser.credentials.list(agentId),
  });

  const forget = useMutation({
    mutationFn: (id: string) => api.browser.credentials.forget(id),
    onSuccess: async () => {
      setForgetting(null);
      setRefusal(null);
      await queryClient.invalidateQueries({ queryKey: ["browser-credentials"] });
    },
    onError: (e: unknown) =>
      setRefusal(
        e instanceof ApiError ? e.message : "Couldn't forget that login. Nothing was deleted.",
      ),
  });

  if (isLoading || !data) return null;
  const logins = data.logins;
  if (logins.length === 0) {
    if (!empty) return null;
    const said = <p className="text-sm leading-[1.5] text-muted-foreground">{empty}</p>;
    return wrap ? wrap(said) : said;
  }

  const list = (
    <>
      <ul className="space-y-2">
        {logins.map((login) => (
          <li
            key={login.id}
            className="flex w-full items-center gap-3.5 rounded-lg border border-hairline bg-background px-4 py-3.5"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-sm font-medium leading-tight [overflow-wrap:anywhere]">
                {login.label}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 text-meta leading-tight text-muted-foreground">
                <span className="font-mono">{login.siteHost}</span>
                <span aria-hidden="true">·</span>
                <span>{lastUsed(login.lastUsedAt)}</span>
              </span>
            </span>
            <Chip>{login.scope === "agent" ? "Everyone using this agent" : "Just you"}</Chip>
            {login.canForget && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:bg-destructive/10"
                onClick={() => {
                  setRefusal(null);
                  setForgetting(login);
                }}
              >
                Forget
              </Button>
            )}
          </li>
        ))}
      </ul>

      <AlertDialog
        open={forgetting !== null}
        onOpenChange={(next) => {
          if (next) return;
          setForgetting(null);
          setRefusal(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {forgetting?.label}?</AlertDialogTitle>
            {/* Ruling R38. A shared login only ever signs in inside a browser
                with nobody's profile, so forgetting it is the whole of
                stopping it. A personal one signs in inside the person's own
                profile, whose cookies outlive this row — said here, with the
                place that removes them, which is all of them: there is no
                per-site removal, so none is promised. */}
            <AlertDialogDescription>
              {forgetting?.scope === "agent"
                ? `The agent stops signing in to ${forgetting?.siteHost} as this account, for everyone. Someone can save a login again the next time a task asks.`
                : `The agent stops signing in to ${forgetting?.siteHost} with it. ${forgetting?.siteHost} may stay signed in inside your own browser profile until its cookies expire. To sign out completely, forget your browser sign-ins in Settings → Browser sign-ins (this signs you out of every site). You can save it again the next time a task asks.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {refusal ? <p className="text-sm leading-[1.45] text-destructive">{refusal}</p> : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={forget.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Kept open so a refusal has somewhere to be read.
                e.preventDefault();
                if (forgetting) forget.mutate(forgetting.id);
              }}
              disabled={forget.isPending}
            >
              {forget.isPending ? "Forgetting…" : "Forget it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  return wrap ? wrap(list) : list;
}
