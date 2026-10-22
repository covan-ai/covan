import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Code2, Database, Search } from "lucide-react";
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
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) {
      toast.error(connectErrorMessage(error));
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
              ? `${pending.toolkit} connected.`
              : `Finishing ${pending.toolkit}…`,
          );
        } else if (!nonce) {
          toast.error(connectErrorMessage("not_yours"));
          return;
        } else if (pending.for === "slack") {
          await api.slack.complete({ grant: pending.grant, nonce });
          toast.success("Slack connected.");
        } else {
          const done = await api.connections.complete({ grant: pending.grant, nonce });
          const label = CONNECTED_LABEL[done.provider] ?? done.provider;
          // A reconnect comes back under its own name, because "Notion
          // connected" after replacing a grant reads as a second connection
          // having appeared — which is exactly what used to happen.
          toast.success(done.reconnected ? `${label} reconnected.` : `${label} connected.`);
        }
      } catch (e) {
        toast.error(
          connectErrorMessage(e instanceof ApiError ? apiErrorCode(e.message) : "save_failed"),
        );
      } finally {
        await queryClient.invalidateQueries();
      }
    };
    void settle();
  }, [queryClient]);
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
 * The search over the page narrows all three at once.
 */
function IntegrationsPage() {
  useGrantOutcome();

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
    if (id === me?.user.id) return "you";
    const name = me?.members.find((m) => m.id === id)?.name;
    return name ? (name.split(/\s+/)[0] ?? name) : null;
  };
  const q = query.trim().toLowerCase();
  const matches = (...texts: Array<string | null | undefined>) =>
    !q || texts.some((t) => t?.toLowerCase().includes(q));

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
          name="Databases and APIs"
          description="Anything with a base address and a token: a Postgres, a Supabase project, a REST API. Read only unless you allow more."
          action={
            <Button size="sm" variant="secondary" onClick={() => setAddingService(true)}>
              Add
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
          name="API"
          description="Keys for your own scripts and tools, and webhooks for what happens here."
          action={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/settings/api-keys">API keys</Link>
            </Button>
          }
        />
      ) : null}
    </>
  );

  return (
    <>
      <SectionTitle
        title="Integrations"
        lede="What the agents can read and where they can write. Each one is turned on per agent in its Configuration."
        action={
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-[220px] items-center gap-2 rounded-md border border-input bg-card px-2.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                aria-label="Search integrations"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Button variant="ghost" onClick={() => setRequesting(true)}>
              Request one
            </Button>
          </div>
        }
      />

      <SectionLabel className="mt-6">Connected · {count}</SectionLabel>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : count === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q
            ? `Nothing connected matches “${query.trim()}”.`
            : "Nothing is connected yet. Connect a source and a folder in Knowledge keeps itself current; connect an app and an agent can call it while it answers."}
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
            <ToolConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}

      <BrowserSignInsSection agentNames={new Map(agents.map((a) => [a.id, a.name]))} />

      {/* A viewer cannot connect anything, so they are not shown a grid of
          things to press. What the workspace already reaches is above. */}
      {canWrite ? (
        <section data-coach="integrations-catalogue" className="mt-8">
          <SectionLabel>Available</SectionLabel>
          <AppCatalogue connected={already} query={query} leading={leading} />
        </section>
      ) : null}

      {(tools.data?.tools ?? []).length > 0 ? (
        <div className="mt-6">
          <ToolList tools={tools.data?.tools ?? []} />
        </div>
      ) : null}

      <p className="mt-6 mb-0 text-meta text-muted-foreground">
        What each source can read, and what it deliberately cannot, is in{" "}
        <DocsLink page="integrations">the integrations guide</DocsLink>. Where routines send their
        results is under{" "}
        <Link to="/settings/preferences" className="underline underline-offset-4">
          delivery channels
        </Link>
        .
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
