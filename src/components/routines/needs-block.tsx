import { Link } from "@tanstack/react-router";
import { useTranslation } from "@/i18n";
import { assetSrc } from "@/lib/api-client";
import { composioLogoPath } from "@/lib/onboarding-config";
import { TOOLKIT_NAME } from "@/lib/use-cases";
import { AppLogo } from "@/components/integrations/app-logo";
import { IntegrationRow } from "@/components/integrations/integration-row";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/** One any-of group a use case needs connected: "Gmail or Outlook". */
export type NeedsGroup = {
  key: string;
  /** "Gmail or Outlook", as `connectionGroupName` says it. */
  name: string;
  toolkits: string[];
  connected: boolean;
  /**
   * Present when the routine changes things in this app. `connectionId` is
   * the connection a "don't ask again" would be written for, or null when
   * this person may not give it there.
   */
  change?: { connectionId: string | null; on: boolean };
};

/**
 * What a use case needs before its first run, between Schedule and
 * Instructions in the editor (B3).
 *
 * Presentational: the editor works out what is connected and who may allow
 * what, and owns every state here. A missing app never blocks Create — the
 * routine is saved and its runs say what they could not reach.
 */
export function NeedsBlock({
  groups,
  agentName,
  onConnect,
  connecting,
  onAllow,
  source,
  browser,
  webSearch,
}: {
  groups: NeedsGroup[];
  agentName: string;
  onConnect: (toolkit: string) => void;
  connecting: boolean;
  onAllow: (connectionId: string, on: boolean) => void;
  source?: { name: string; connected: boolean };
  browser?: { on: boolean; onChange: (on: boolean) => void };
  webSearch?: { on: boolean; agentId: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <ul className="m-0 list-none border-t border-hairline p-0">
        {groups.map((g) => (
          <IntegrationRow
            key={g.key}
            compact
            logo={
              <AppLogo
                src={assetSrc(composioLogoPath(g.toolkits[0] ?? ""))}
                name={TOOLKIT_NAME[g.toolkits[0] ?? ""] ?? g.name}
                size={28}
              />
            }
            name={g.name}
            status={g.connected ? { state: "done", text: t("Connected") } : undefined}
            action={
              g.connected ? undefined : (
                <span className="flex flex-wrap justify-end gap-1">
                  {g.toolkits.map((toolkit) => (
                    <Button
                      key={toolkit}
                      size="sm"
                      variant="secondary"
                      disabled={connecting}
                      onClick={() => onConnect(toolkit)}
                    >
                      {t("Connect {{app}}", { app: TOOLKIT_NAME[toolkit] ?? toolkit })}
                    </Button>
                  ))}
                </span>
              )
            }
          />
        ))}
        {source ? (
          <IntegrationRow
            compact
            logo={<span className="size-7 shrink-0" aria-hidden />}
            name={source.name}
            status={source.connected ? { state: "done", text: t("Connected") } : undefined}
            action={
              source.connected ? undefined : (
                <Button asChild size="sm" variant="secondary">
                  <Link to="/settings/integrations">{t("Connect in Settings")}</Link>
                </Button>
              )
            }
          />
        ) : null}
      </ul>

      {groups
        .filter((g) => g.connected && g.change)
        .map((g) =>
          g.change && g.change.connectionId ? (
            <div key={`allow-${g.key}`} className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={`allow-${g.key}`} className="text-sm">
                  {t("Let {{agent}} change things in {{app}} without asking", {
                    agent: agentName,
                    app: g.name,
                  })}
                </label>
                <Switch
                  id={`allow-${g.key}`}
                  checked={g.change.on}
                  onCheckedChange={(on) => onAllow(g.change!.connectionId!, on)}
                />
              </div>
              <p className="m-0 text-meta text-muted-foreground">
                {t(
                  "Off, it still runs, reports what it would have changed, and changes nothing. On, it also stops the asking in chats with {{agent}}; turn it off on Integrations.",
                  { agent: agentName },
                )}
              </p>
            </div>
          ) : (
            <p key={`allow-${g.key}`} className="m-0 text-meta text-muted-foreground">
              {t("Only the person who connected {{app}}, or an admin, can allow this.", {
                app: g.name,
              })}
            </p>
          ),
        )}

      {browser ? (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="needs-browser" className="text-sm">
            {t("Let it use a browser")}
          </label>
          <Switch id="needs-browser" checked={browser.on} onCheckedChange={browser.onChange} />
        </div>
      ) : null}

      {webSearch ? (
        <p className="m-0 text-meta text-muted-foreground">
          {webSearch.on
            ? t("Web search is on for {{agent}}.", { agent: agentName })
            : t("Web search is off for {{agent}}.", { agent: agentName })}{" "}
          <Link
            to="/agents/$agentId/configuration"
            params={{ agentId: webSearch.agentId }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t("Configuration")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
