import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { api, assetSrc } from "@/lib/api-client";
import { scopeWords, type ToolConnection, type ToolConnectionGrant } from "@/lib/connections-api";
import { canWriteAsRole } from "@/lib/roles";
import {
  useComposioStatus,
  useConnectionGrants,
  useRemoveConnectionGrant,
  useRemoveToolConnection,
} from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { SCAN_TOOLKITS } from "@/lib/arrivals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConnectionScope } from "./connection-scope";
import { IntegrationRow } from "./integration-row";

/**
 * The applications this workspace has connected, as rows in Connected (A8).
 *
 * Each row says what it is, whose it is and how it is doing; Manage holds
 * the rest — who may use it, which agents change things in it without
 * asking, why an operation is hidden, and the way back out. The catalogue to connect more
 * from is `AppCatalogue`, in Available.
 */
export function ConnectedApps({
  connections,
  agents,
}: {
  connections: ToolConnection[];
  /** Only to put a name beside a standing permission. */
  agents: Array<{ id: string; name: string }>;
}) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  const canWrite = me ? canWriteAsRole(myRole) : false;

  const grants = useConnectionGrants();
  const standing = new Map<string, ToolConnectionGrant[]>();
  for (const grant of grants.data?.grants ?? []) {
    const list = standing.get(grant.connectionId);
    if (list) list.push(grant);
    else standing.set(grant.connectionId, [grant]);
  }
  const agentNames = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <>
      {connections
        .filter((c) => c.transport === "composio")
        .map((c) => (
          <ConnectedAppRow
            key={c.id}
            connection={c}
            grants={standing.get(c.id) ?? []}
            agentNames={agentNames}
            canWrite={canWrite}
          />
        ))}
    </>
  );
}

/**
 * One connected application.
 *
 * A row that is still `pending` polls, because a person who has just come back
 * from a consent screen should see it settle rather than reload the page to
 * find out. The poll stops the moment it is not pending.
 *
 * Removing it revokes the grant at Composio before the row goes. That is the
 * whole reason removal is a route call rather than a delete: a deleted row with
 * a live grant is an OAuth token nobody in this product can see or take back.
 */
function ConnectedAppRow({
  connection,
  grants,
  agentNames,
  canWrite,
}: {
  connection: ToolConnection;
  grants: ToolConnectionGrant[];
  agentNames: Map<string, string>;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const remove = useRemoveToolConnection();
  const [managing, setManaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const abandoned = isAbandoned(connection);
  useComposioStatus(connection.id, connection.status === "pending" && !abandoned);
  const app = connection.label;

  const status = abandoned
    ? { state: "idle" as const, text: t("Not finished") }
    : connection.status === "pending"
      ? { state: "running" as const, text: t("Finishing…") }
      : connection.status === "failed"
        ? { state: "failed" as const, text: t("Not connected") }
        : connection.verifyError
          ? { state: "failed" as const, text: t("Key refused") }
          : { state: "done" as const, text: t("Working") };

  return (
    <>
      <IntegrationRow
        logo={<AppLogo src={assetSrc(connection.logoPath)} name={connection.label} size={36} />}
        name={connection.label}
        description={[
          connection.toolkitSlug,
          scopeWords(connection, t),
          grants.length > 0
            ? t("{{count}} agent changes things without asking", {
                count: grants.length,
                defaultValue_other: "{{count}} agents change things without asking",
              })
            : null,
          connection.unavailable
            ? t("{{count}} operation hidden", {
                count: connection.unavailable.count,
                defaultValue_other: "{{count}} operations hidden",
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        status={status}
        action={
          <span className="flex items-center gap-1">
            {connection.mine &&
              connection.status === "active" &&
              (SCAN_TOOLKITS as readonly string[]).includes(connection.toolkitSlug ?? "") && (
                // 0139: a mailbox or calendar of your own leads to what arrives there.
                <Button asChild size="sm" variant="ghost">
                  <Link to="/arrivals">{t("What arrives here")}</Link>
                </Button>
              )}
            <Button size="sm" variant="secondary" onClick={() => setManaging(true)}>
              {t("Manage")}
            </Button>
          </span>
        }
      />

      <Dialog
        open={managing}
        onOpenChange={(v) => {
          setManaging(v);
          if (!v) setConfirming(false);
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{connection.label}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {connection.status === "active" && connection.verifyError ? (
              <p className="m-0 text-meta leading-[1.45] text-muted-foreground">
                {connection.verifyError} {t("Remove it and connect again with a working one.")}
              </p>
            ) : null}

            {abandoned ? (
              <p className="m-0 text-meta text-muted-foreground">
                {t(
                  "The sign-in for {{app}} was not finished, so agents cannot use it. Remove this and connect it again from Available.",
                  { app },
                )}
              </p>
            ) : null}

            {/* The service answered "no such operation" for these, so the
                agent is not offered them, and the thirty days
                `unavailable_tools` trusts that answer for is when they are
                tried again (covan#276). */}
            {connection.unavailable ? (
              <p className="m-0 text-meta text-muted-foreground">
                {t(
                  "{{app}} refused an operation when an agent tried it, so agents are not offered it.",
                  {
                    app,
                    count: connection.unavailable.count,
                    defaultValue_other:
                      "{{app}} refused some operations when an agent tried them, so agents are not offered them.",
                  },
                )}
                {connection.unavailable.hiddenUntil !== null
                  ? ` ${t("Tried again from {{date}}.", {
                      date: retryDate(connection.unavailable.hiddenUntil, locale),
                    })}`
                  : null}
              </p>
            ) : null}

            {connection.status === "active" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("Who can use it")}</span>
                <ConnectionScope connection={connection} />
              </div>
            ) : null}

            {/* Agents read this app without asking. Only the agents somebody
                let change things here without asking are listed; every other
                change asks first, and the absence of a row IS the asking (0140). */}
            {grants.length > 0 ? (
              <div>
                <div className="mb-1 text-sm font-medium">{t("Changes things without asking")}</div>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {grants.map((grant) => (
                    <StandingGrant
                      key={grant.agentId}
                      grant={grant}
                      agentName={agentNames.get(grant.agentId) ?? t("an agent")}
                      appName={app}
                      canWrite={canWrite}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {canWrite ? (
              <div className="flex items-center gap-2 border-t border-hairline pt-3">
                {confirming ? (
                  <>
                    <span className="flex-1 text-meta text-muted-foreground">
                      {t("Agents lose {{app}} at once, and the grant at Composio is revoked.", {
                        app,
                      })}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                      {t("Keep")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() =>
                        remove.mutate(connection.id, {
                          onSuccess: () => {
                            setManaging(false);
                            toast.success(t("{{app}} disconnected.", { app }));
                          },
                          onError: (err) =>
                            toast.error(
                              err instanceof Error ? err.message : t("Could not remove that"),
                            ),
                        })
                      }
                    >
                      {remove.isPending ? t("Removing…") : t("Remove")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirming(true)}
                  >
                    {t("Remove {{app}}…", { app })}
                  </Button>
                )}
              </div>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * How long a sign-in may stay unfinished before the row stops saying
 * "Finishing…".
 *
 * Closing Composio's window halfway leaves the row `pending` for good: nothing
 * comes back to settle it. Ten minutes is long enough to go and find an API
 * key, and the row still turns active if the sign-in does finish later — this
 * only changes what an unfinished one is called, and stops asking about it.
 */
const PENDING_GIVES_UP_MS = 10 * 60_000;

function isAbandoned(connection: ToolConnection): boolean {
  return connection.status === "pending" && Date.now() - connection.createdAt > PENDING_GIVES_UP_MS;
}

/** The day a hidden operation is offered again, in the interface's language. */
function retryDate(at: number, locale: string): string {
  return new Date(at).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * One agent that may change things in this app without asking, and the way
 * back out of it.
 *
 * Removal is any writer's who can edit the agent, not only the person who
 * granted it (0140): taking a standing permission away can never be the unsafe
 * direction, and the only people able to remove one must not be the people who
 * could give it.
 *
 * No confirmation step, unlike disconnecting the app above. Removing a
 * permission cannot be the unsafe direction, and a card that asks "are you
 * sure?" before making something safer teaches people to click through the
 * question that matters.
 */
function StandingGrant({
  grant,
  agentName,
  appName,
  canWrite,
}: {
  grant: ToolConnectionGrant;
  agentName: string;
  appName: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const revoke = useRemoveConnectionGrant();
  return (
    <li className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{agentName}</span>
      {canWrite ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(
              { agentId: grant.agentId, connectionId: grant.connectionId },
              {
                onSuccess: () =>
                  toast.success(
                    t("{{agent}} will ask before changing anything in {{app}}.", {
                      agent: agentName,
                      app: appName,
                    }),
                  ),
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : t("Could not remove that")),
              },
            )
          }
        >
          {t("Ask first")}
        </Button>
      ) : null}
    </li>
  );
}
