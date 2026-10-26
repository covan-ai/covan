import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { api, assetSrc } from "@/lib/api-client";
import { scopeWords, type ToolConnection, type ToolConnectionGrant } from "@/lib/connections-api";
import { dismiss, isDismissed } from "@/lib/dismissed";
import { canWriteAsRole } from "@/lib/roles";
import {
  useComposioGrants,
  useComposioStatus,
  useRemoveComposioGrant,
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
 * the rest — who may use it, the operations it runs without asking, why an
 * operation is hidden, and the way back out. The catalogue to connect more
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

  const grants = useComposioGrants();
  const standing = new Map<string, ToolConnectionGrant[]>();
  for (const grant of grants.data?.grants ?? []) {
    if (grant.mode !== "always") continue;
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
      {isNewScanConnection(connection) && <ScanToast connection={connection} />}
      <IntegrationRow
        logo={<AppLogo src={assetSrc(connection.logoPath)} name={connection.label} size={36} />}
        name={connection.label}
        description={[
          connection.toolkitSlug,
          scopeWords(connection, t),
          grants.length > 0
            ? t("{{count}} operation runs without asking", {
                count: grants.length,
                defaultValue_other: "{{count}} operations run without asking",
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

            {/* Only the standing permissions are listed, because only they are
                a thing somebody granted. Everything else on this app asks, and
                the absence of a row IS the asking (0063). */}
            {grants.length > 0 ? (
              <div>
                <div className="mb-1 text-sm font-medium">{t("Runs without asking")}</div>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {grants.map((grant) => (
                    <StandingGrant
                      key={`${grant.agentId}:${grant.slug}`}
                      grant={grant}
                      agentName={agentNames.get(grant.agentId) ?? t("an agent")}
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

/**
 * A mailbox or calendar of the person's own that finished connecting within the
 * time a sign-in may take: the one moment worth saying that a scan of it exists
 * (covan#403). An older connection is not new, whatever page it is shown on.
 */
function isNewScanConnection(connection: ToolConnection): boolean {
  return (
    connection.mine &&
    connection.status === "active" &&
    !connection.verifyError &&
    (SCAN_TOOLKITS as readonly string[]).includes(connection.toolkitSlug ?? "") &&
    Date.now() - connection.createdAt <= PENDING_GIVES_UP_MS
  );
}

/**
 * Says, once per connection, that what arrives in a mailbox or calendar that has
 * just connected can be scanned, and offers the scan.
 *
 * The marker is kept in the tab's session, so drawing the row again, or
 * coming back from Composio's window with a reload, does not say it twice.
 */
function ScanToast({ connection }: { connection: ToolConnection }) {
  const { t } = useTranslation();
  const router = useRouter();
  const announced = useRef(false);
  const { id, label: app } = connection;

  useEffect(() => {
    const marker = `arrivals-toast:${id}`;
    if (announced.current || isDismissed(marker)) return;
    announced.current = true;
    dismiss(marker);
    toast.success(t("{{app}} is connected. Scan it to see what arrives.", { app }), {
      action: {
        label: t("Scan now"),
        onClick: () => router.history.push("/arrivals?scan=1"),
      },
    });
  }, [id, app, router, t]);

  return null;
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
 * One permission an agent was given in advance, and the way back out of it.
 *
 * Removal is an ordinary writer's, not an admin's, and the asymmetry is
 * 0058's: a writer who cannot raise a grant to `always` must still be able to
 * lower one from it, or the only people who could take a standing permission
 * away would be the people who could give it. That gets the direction of
 * caution exactly backwards.
 *
 * No confirmation step, unlike disconnecting the app above. Removing a
 * permission cannot be the unsafe direction, and a card that asks "are you
 * sure?" before making something safer teaches people to click through the
 * question that matters.
 */
function StandingGrant({
  grant,
  agentName,
  canWrite,
}: {
  grant: ToolConnectionGrant;
  agentName: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const revoke = useRemoveComposioGrant();
  return (
    <li className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        <span className="font-mono">{grant.slug}</span> ·{" "}
        {t("{{agent}} runs this without asking", { agent: agentName })}
      </span>
      {canWrite ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(
              {
                agentId: grant.agentId,
                connectionId: grant.connectionId,
                slug: grant.slug,
              },
              {
                onSuccess: () =>
                  toast.success(
                    t("{{agent}} will ask before {{operation}}.", {
                      agent: agentName,
                      operation: grant.slug,
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
