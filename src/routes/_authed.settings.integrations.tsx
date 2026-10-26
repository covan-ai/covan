import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Code2, Database, Search } from "lucide-react";
import { Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { SectionLabel, SectionTitle } from "@/components/section";
import { BrowserSignInsSection } from "@/components/browser-signins-section";
import { DocsLink } from "@/components/docs-link";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { Button } from "@/components/ui/button";
import { ConnectionRow, SourceCard } from "@/components/integrations/connection-card";
import { AddServiceDialog } from "@/components/integrations/add-service-dialog";
import { AppCatalogue } from "@/components/integrations/app-catalogue";
import { IntegrationCard } from "@/components/integrations/integration-row";
import { ToolConnectionRow, ToolList } from "@/components/integrations/tool-connection-card";
import { ConnectedApps } from "@/components/integrations/composio-card";
import { SlackCard, SlackRow } from "@/components/integrations/slack-card";
import { useConnections, useSlack, useToolConnections } from "@/hooks/use-connections";
import { useAgentsStore } from "@/lib/agents-store";
import { useWorkspaceRole } from "@/lib/workspace-role";
import { connectErrorMessage } from "@/lib/connections-api";
import { api, ApiError } from "@/lib/api-client";
import { endFlow, flowNonce } from "@/lib/flow-nonce";
import { takePendingGrant } from "@/lib/sensitive-url";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/_authed/settings/integrations")({
  component: IntegrationsPage,
  head: () => ({
    meta: [
      { title: "Integrations — Covan" },
      { name: "description", content: "Connect your team's tools and APIs." },
    ],
  }),
});

/**
 * What a provider is called once it has come back from a consent screen.
 * The callback can only speak through a query parameter, so this is the other
 * half of that sentence.
 */
const CONNECTED_LABEL: Record<string, string> = {
  notion: "Notion",
  google_drive: "Google Drive",
  slack: "Slack",
};

/**
 * Finish a flow the provider sent this tab back from, and say how it went.
 *
 * The provider's redirect carries a grant rather
 * than a finished connection: the callback cannot tell who is at the browser,
 * so it decides nothing, and this page completes the flow with an
 * authenticated request — as the person who started it, holding the nonce this
 * tab started it with. `lib/sensitive-url.ts` has already taken the grant out
 * of the address bar into session storage; reading it here removes it, so it
 * is finished at most once, StrictMode's double effect included.
 *
 * Errors still arrive as `?error=` from the callback itself (cancelled,
 * expired) and are read the way they always were.
 */
function useGrantOutcome() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) {
      toast.error(connectErrorMessage(error, t));
      window.history.replaceState({}, "", window.location.pathname);
    }

    const pending = takePendingGrant();
    if (!pending) return;
    const nonce = flowNonce();
    endFlow();

    const settle = async () => {
      try {
        if (pending.kind === "composio") {
          const done = await api.composio.complete(pending.nonce);
          toast.success(
            done.status === "active"
              ? t("{{app}} connected.", { app: pending.toolkit })
              : t("Finishing {{app}}…", { app: pending.toolkit }),
          );
        } else if (!nonce) {
          toast.error(connectErrorMessage("not_yours", t));
          return;
        } else if (pending.for === "slack") {
          await api.slack.complete({ grant: pending.grant, nonce });
          toast.success(t("Slack connected."));
        } else {
          const done = await api.connections.complete({ grant: pending.grant, nonce });
          const label = CONNECTED_LABEL[done.provider] ?? done.provider;
          // A reconnect comes back under its own name, because "Notion
          // connected" after replacing a grant reads as a second connection
          // having appeared — which is exactly what used to happen.
          toast.success(
            done.reconnected
              ? t("{{app}} reconnected.", { app: label })
              : t("{{app}} connected.", { app: label }),
          );
        }
      } catch (e) {
        toast.error(
          connectErrorMessage(e instanceof ApiError ? apiErrorCode(e.message) : "save_failed", t),
        );
      } finally {
        await queryClient.invalidateQueries();
      }
    };
    void settle();
  }, [queryClient, t]);
}

/** The API answers `{ error: "<code>" }`; `ApiError` carries the code as its message. */
function apiErrorCode(message: string): string {
  return /^[a-z_]+$/.test(message) ? message : "save_failed";
}

/**
 * Settings › Integrations (A8): what the agents can read and where they can
 * write.
 *
 * - **Connected · N** — every connected thing as one row: sources syncing into
 *   Knowledge, Slack, connected apps, databases and APIs. Manage opens what
 *   used to unfold in place, so the page is the same height before and after
 *   anything is pressed.
 * - **Saved sign-ins** — the logins an agent's browser may use, the cookie jar
 *   and the browsers still open; each hides itself when empty.
 * - **Available** — the catalogue, visible before anybody types: the sources,
 *   Slack, a database or an API by hand, the REST API, and Composio's apps.
 *
 * The search over the page narrows all three at once. The catalogue carries a
 * second field bound to the same query, pinned under the top bar while its
 * grid scrolls, and "/" focuses it: by the time somebody is scrolling tiles
 * the one up here is off the screen.
 */
function IntegrationsPage() {
  useGrantOutcome();
  const { t } = useTranslation();
  const locale = useLocale();

  const [query, setQuery] = useState("");
  const [addingService, setAddingService] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const connections = useConnections();
  const tools = useToolConnections();
  const slack = useSlack();
  const { bundles, agents } = useAgentsStore();
  const { me, canWrite } = useWorkspaceRole();

  const firstNameOf = (id: string | null | undefined) => {
    if (!id) return null;
    if (id === me?.user.id) return t("you");
    const name = me?.members.find((m) => m.id === id)?.name;
    return name ? (name.split(/\s+/)[0] ?? name) : null;
  };
  const q = query.trim().toLocaleLowerCase(locale);
  const matches = (...texts: Array<string | null | undefined>) =>
    !q || texts.some((text) => text?.toLocaleLowerCase(locale).includes(q));

  const toolConnections = tools.data?.connections ?? [];
  const sources = (connections.data?.connections ?? []).filter((c) =>
    matches(c.provider.replace("_", " "), c.accountLabel, c.bundleName, c.folderName),
  );
  const providers = (connections.data?.providers ?? []).filter((p) => matches(p.label));
  const installation =
    slack.data?.installation && matches("slack", slack.data.installation.teamName)
      ? slack.data.installation
      : null;
  const apps = toolConnections.filter(
    (c) => c.transport === "composio" && matches(c.label, c.toolkitSlug),
  );
  const services = toolConnections.filter(
    (c) => c.transport !== "composio" && matches(c.label, c.baseUrl),
  );
  const count = sources.length + (installation ? 1 : 0) + apps.length + services.length;
  // Counted from the active rows only: a sign-in somebody closed halfway
  // leaves a `pending` row, and it is not connected.
  const already = new Set(
    toolConnections
      .filter((c) => c.transport === "composio" && c.status === "active")
      .map((c) => c.toolkitSlug ?? ""),
  );
  const loading = connections.isPending || tools.isPending || slack.isPending;

  const leading = (
    <>
      {providers.map((provider) => (
        <SourceCard key={provider.id} provider={provider} bundles={bundles} />
      ))}
      {slack.data && !slack.data.installation && matches("slack") ? (
        <SlackCard state={slack.data} />
      ) : null}
      {matches("databases and apis", "postgres", "supabase", "rest", "http") ? (
        <IntegrationCard
          logo={
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-chip-foreground">
              <Database className="size-3.5" aria-hidden />
            </span>
          }
          name={t("Databases and APIs")}
          description={t(
            "Anything with a base address and a token: a Postgres, a Supabase project, a REST API. Read only unless you allow more.",
          )}
          action={
            <Button size="sm" variant="secondary" onClick={() => setAddingService(true)}>
              {t("Add")}
            </Button>
          }
        />
      ) : null}
      {matches("api", "keys") ? (
        <IntegrationCard
          logo={
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-chip-foreground">
              <Code2 className="size-3.5" aria-hidden />
            </span>
          }
          name={t("API")}
          description={t(
            "Keys for your own scripts and tools, and webhooks for what happens here.",
          )}
          action={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/settings/api-keys">{t("API keys")}</Link>
            </Button>
          }
        />
      ) : null}
    </>
  );

  return (
    <>
      <SectionTitle
        title={t("Integrations")}
        lede={t(
          "Agents read what you connect without asking, and ask before changing anything unless you said not to for that app. Each one is turned on per agent in its Configuration.",
        )}
        action={
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-[220px] items-center gap-2 rounded-md border border-input bg-card px-2.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                aria-label={t("Search integrations")}
                placeholder={t("Search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Button variant="ghost" onClick={() => setRequesting(true)}>
              {t("Request one")}
            </Button>
          </div>
        }
      />

      <SectionLabel className="mt-6">{t("Connected · {{total}}", { total: count })}</SectionLabel>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : count === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q
            ? t("Nothing connected matches “{{query}}”.", { query: query.trim() })
            : t(
                "Nothing is connected yet. Connect a source and a folder in Knowledge keeps itself current; connect an app and an agent can call it while it answers.",
              )}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {sources.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              connectedBy={firstNameOf(connection.userId)}
            />
          ))}
          {installation ? (
            <SlackRow
              installation={installation}
              agents={agents}
              installedBy={firstNameOf(installation.installedBy)}
            />
          ) : null}
          <ConnectedApps connections={apps} agents={agents} />
          {services.map((connection) => (
            <ToolConnectionRow key={connection.id} connection={connection} agents={agents} />
          ))}
        </ul>
      )}

      <BrowserSignInsSection agentNames={new Map(agents.map((a) => [a.id, a.name]))} />

      {/* A viewer cannot connect anything, so they are not shown a grid of
          things to press. What the workspace already reaches is above. */}
      {canWrite ? (
        <section data-coach="integrations-catalogue" className="mt-8">
          <SectionLabel>{t("Available")}</SectionLabel>
          <AppCatalogue
            connected={already}
            query={query}
            onQueryChange={setQuery}
            leading={leading}
          />
        </section>
      ) : null}

      {(tools.data?.tools ?? []).length > 0 ? (
        <div className="mt-6">
          <ToolList tools={tools.data?.tools ?? []} />
        </div>
      ) : null}

      <p className="mt-6 mb-0 text-meta text-muted-foreground">
        <Trans
          t={t}
          i18nKey="What each source can read, and what it deliberately cannot, is in <docs>the integrations guide</docs>. Where routines send their results is under <a>delivery channels</a>."
          components={{
            docs: <DocsLink page="integrations">{null}</DocsLink>,
            a: <Link to="/settings/preferences" className="underline underline-offset-4" />,
          }}
        />
      </p>

      <AddServiceDialog open={addingService} onOpenChange={setAddingService} />
      <FeedbackDialog
        open={requesting}
        onOpenChange={setRequesting}
        path="/settings/integrations"
        initialKind="idea"
      />
    </>
  );
}
