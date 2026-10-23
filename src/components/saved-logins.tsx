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
import { useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { AppLogo } from "@/components/integrations/app-logo";
import { IntegrationRow } from "@/components/integrations/integration-row";
import { api, type SavedLogin } from "@/lib/api-client";
import { ApiError } from "@/lib/api-error";
import { agoShort } from "@/lib/day-groups";

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

function lastUsed(at: string | null, t: TFunction, locale: string): string {
  if (!at) return t("Not used yet");
  return t("Last used {{when}}", { when: agoShort(Date.parse(at), undefined, t, locale) });
}

export function SavedLoginsList({
  agentId,
  agentNames,
  empty,
  wrap,
}: {
  /** One agent's logins; omitted, every login the caller can see. */
  agentId?: string;
  /** To say which agent each login is for, on a list of every agent's. */
  agentNames?: Map<string, string>;
  /** What to say when there are none; omitted, the list renders nothing then. */
  empty?: string;
  /** The frame around the list — a settings section — drawn only when there is a list to frame. */
  wrap?: (list: ReactElement, count: number) => ReactElement;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
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
        e instanceof ApiError ? e.message : t("Couldn't forget that login. Nothing was deleted."),
      ),
  });

  if (isLoading || !data) return null;
  const logins = data.logins;
  if (logins.length === 0) {
    if (!empty) return null;
    const said = <p className="text-sm leading-[1.5] text-muted-foreground">{empty}</p>;
    return wrap ? wrap(said, 0) : said;
  }

  const list = (
    <>
      <ul className="m-0 list-none p-0">
        {logins.map((login) => {
          const agent = agentId ? null : agentNames?.get(login.agentId);
          return (
            <IntegrationRow
              key={login.id}
              compact
              logo={<AppLogo name={login.label} size={28} />}
              name={login.label}
              description={
                <>
                  {agent ? <span>{agent} · </span> : null}
                  <span>{login.siteHost}</span>
                  {" · "}
                  <span>
                    {login.scope === "agent" ? t("Everyone using this agent") : t("Just you")}
                  </span>
                  {" · "}
                  <span>{lastUsed(login.lastUsedAt, t, locale)}</span>
                </>
              }
              action={
                login.canForget ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRefusal(null);
                      setForgetting(login);
                    }}
                  >
                    {t("Forget")}
                  </Button>
                ) : undefined
              }
            />
          );
        })}
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
            <AlertDialogTitle>
              {t("Forget {{label}}?", { label: forgetting?.label })}
            </AlertDialogTitle>
            {/* Ruling R38. A shared login only ever signs in inside a browser
                with nobody's profile, so forgetting it is the whole of
                stopping it. A personal one signs in inside the person's own
                profile, whose cookies outlive this row — said here, with the
                place that removes them, which is all of them: there is no
                per-site removal, so none is promised. */}
            <AlertDialogDescription>
              {forgetting?.scope === "agent"
                ? t(
                    "The agent stops signing in to {{site}} as this account, for everyone. Someone can save a login again the next time a task asks.",
                    { site: forgetting?.siteHost },
                  )
                : t(
                    "The agent stops signing in to {{site}} with it. {{site}} may stay signed in inside your own browser profile until its cookies expire. To sign out completely, forget your browser sign-ins in Settings → Browser sign-ins (this signs you out of every site). You can save it again the next time a task asks.",
                    { site: forgetting?.siteHost },
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {refusal ? <p className="text-sm leading-[1.45] text-destructive">{refusal}</p> : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={forget.isPending}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Kept open so a refusal has somewhere to be read.
                e.preventDefault();
                if (forgetting) forget.mutate(forgetting.id);
              }}
              disabled={forget.isPending}
            >
              {forget.isPending ? t("Forgetting…") : t("Forget it")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  return wrap ? wrap(list, logins.length) : list;
}
