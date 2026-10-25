import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { ApiError, api, assetSrc } from "@/lib/api-client";
import { SCAN_TOOLKITS, type ScanToolkit } from "@/lib/arrivals";
import { connectErrorMessage } from "@/lib/connections-api";
import { docsUrl } from "@/lib/docs";
import { takePendingGrant } from "@/lib/sensitive-url";
import {
  toolConnectionsKey,
  useConnectComposio,
  useToolConnections,
} from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { IntegrationRow } from "@/components/integrations/integration-row";
import { Button } from "@/components/ui/button";

/** Brand names, said the same in every language. */
const NAME: Record<ScanToolkit, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  googlecalendar: "Google Calendar",
};

/** The mark Composio publishes for the toolkit, through the worker's logo proxy. */
function logoPath(toolkit: ScanToolkit): string {
  return `/composio/logo?u=${encodeURIComponent(`https://logos.composio.dev/api/${toolkit}`)}`;
}

function isScanToolkit(x: string): x is ScanToolkit {
  return (SCAN_TOOLKITS as readonly string[]).includes(x);
}

/**
 * Gmail, Outlook and Google Calendar, each connected from the page somebody
 * is on (the welcome step, `/arrivals`).
 *
 * Connecting is the consent screen Composio hosts, a full page away; the
 * worker sends the person back to `returnTo` with the grant in the address,
 * `lib/sensitive-url.ts` moves it into session storage, and this finishes it
 * on the way back in — what `useGrantOutcome` does on Settings › Integrations,
 * for the three toolkits a scan reads. Only the person's own connections
 * count: a scan reads nobody else's mail (0098).
 */
export function ConnectCards({
  returnTo,
  onConnected,
}: {
  returnTo: string;
  /** A mailbox or calendar just finished connecting. */
  onConnected?: (toolkit: ScanToolkit) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useToolConnections();
  const connect = useConnectComposio();
  // The latest callback, for an effect that runs once: a grant is finished at
  // most once, whatever the parent re-renders with in the meantime.
  const reported = useRef(onConnected);
  useEffect(() => {
    reported.current = onConnected;
  });

  useEffect(() => {
    const pending = takePendingGrant();
    if (!pending || pending.kind !== "composio") return;
    void (async () => {
      try {
        const done = await api.composio.complete(pending.nonce);
        if (done.status === "active" && isScanToolkit(pending.toolkit)) {
          reported.current?.(pending.toolkit);
        }
      } catch (e) {
        toast.error(connectErrorMessage(e instanceof ApiError ? e.message : "save_failed", t));
      } finally {
        await queryClient.invalidateQueries({ queryKey: toolConnectionsKey });
      }
    })();
  }, [queryClient, t]);

  const connected = new Set(
    (data?.connections ?? [])
      .filter((c) => c.mine && c.transport === "composio" && c.status === "active")
      .map((c) => c.toolkitSlug),
  );

  return (
    <div className="space-y-3">
      <ul className="border-t border-hairline">
        {SCAN_TOOLKITS.map((toolkit) => (
          <IntegrationRow
            key={toolkit}
            logo={<AppLogo src={assetSrc(logoPath(toolkit))} name={NAME[toolkit]} size={36} />}
            name={NAME[toolkit]}
            status={connected.has(toolkit) ? { state: "done", text: t("Connected") } : undefined}
            action={
              connected.has(toolkit) ? (
                <span className="text-meta text-muted-foreground sm:hidden">{t("Connected")}</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={connect.isPending}
                  onClick={() =>
                    connect.mutate(
                      { toolkit, returnTo },
                      { onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) },
                    )
                  }
                >
                  {t("Connect")}
                </Button>
              )
            }
          />
        ))}
      </ul>
      <p className="text-meta text-muted-foreground">
        {t(
          "Covan reads the last thirty days and keeps only the counts, a short name for each kind and up to three example subjects — never addresses or messages.",
        )}{" "}
        <a
          href={`${docsUrl("integrations")}#what-a-scan-reads-and-keeps`}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t("What Covan reads and keeps")}
        </a>
      </p>
    </div>
  );
}
