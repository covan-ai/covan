import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Code2, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  PageContainer,
  PageHeader,
  PanelEyebrow,
  SectionHeading,
} from "@/components/page-container";
import { Chip, EmptyState, SectionCard } from "@/components/section-card";
import { DocsLink } from "@/components/docs-link";
import { Button } from "@/components/ui/button";
import { ConnectionCard, ConnectSourceCard } from "@/components/integrations/connection-card";
import { AddServiceDialog } from "@/components/integrations/add-service-dialog";
import { ToolConnectionCard, ToolList } from "@/components/integrations/tool-connection-card";
import { ComposioCard } from "@/components/integrations/composio-card";
import { SlackCard } from "@/components/integrations/slack-card";
import { SlackMark } from "@/components/integrations/brand-marks";
import { useConnections, useSlack, useToolConnections } from "@/hooks/use-connections";
import { useAgentsStore } from "@/lib/agents-store";
import { connectErrorMessage } from "@/lib/connections-api";

export const Route = createFileRoute("/_authed/integrations")({
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
 * Read the outcome of a grant out of the URL, say it once, and take it out of
 * the address bar.
 *
 * `replaceState` rather than a router navigation: this is not a place in the
 * application, it is a message that has been delivered. Left in place it would
 * re-announce itself on every reload and, worse, would still be there when
 * somebody copied the link.
 */
function useGrantOutcome() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    // A reconnect comes back under its own name, because "Notion connected"
    // after replacing a grant reads as a second connection having appeared —
    // which is exactly what used to happen, and exactly what this stopped.
    const reconnected = params.get("reconnected");
    const error = params.get("error");
    if (!connected && !reconnected && !error) return;

    if (reconnected) {
      toast.success(`${CONNECTED_LABEL[reconnected] ?? reconnected} reconnected.`);
    }

    if (connected) {
      toast.success(`${CONNECTED_LABEL[connected] ?? connected} connected.`);
    } else if (error) {
      toast.error(connectErrorMessage(error));
    }

    window.history.replaceState({}, "", window.location.pathname);
  }, []);
}

/**
 * Three sections, and they were four.
 *
 * WHAT THIS PAGE LOOKED LIKE BEFORE, because the shape is the change.
 * "Connected sources" and "Add a source" were two top-level sections asking
 * one question between them, so a workspace with one Notion connection read
 * its provider list twice. "Services an agent can call" then held five
 * different things in a single column — an account card with rows inside it,
 * an applications card with rows and a search field inside it, loose
 * full-width cards per service, a two-hundred-line form that unfolded in
 * place, and a list of every tool in the build. Cards inside cards, and a
 * page whose height changed on every click.
 *
 * The rules it follows now:
 *
 * - **One subject per card, and no card inside a card.** A connected thing is
 *   a row. A row never contains a card.
 * - **Nothing expands in place.** Every form that used to unfold is a dialog
 *   (`add-service-dialog`, and both of the Supabase ones), so the page is the
 *   same height before and after you press anything.
 * - **The catalogue is visible before you type.** That is `AppCatalogue`, and
 *   it is the reason the applications card is the largest thing here.
 */
function IntegrationsPage() {
  useGrantOutcome();

  const connections = useConnections();
  const tools = useToolConnections();
  const slack = useSlack();
  const { bundles, agents } = useAgentsStore();
  const [addingService, setAddingService] = useState(false);

  const live = connections.data?.connections ?? [];
  // Every provider is offered every time, connected or not: one team's Notion
  // feeds three bundles, and deciding for them which of those is "enough" is
  // not a judgement this page can make.
  const providers = connections.data?.providers ?? [];
  // A connected application is listed inside the card one up rather than a
  // second time here — one place to see it, one place to remove it.
  const services = (tools.data?.connections ?? []).filter((c) => c.transport !== "composio");
  const availableTools = tools.data?.tools ?? [];

  return (
    <AppShell>
      <PageContainer width="list">
        <PageHeader
          badge="Integrations"
          title="Where the knowledge comes from."
          turn="And where the answers go."
        />

        {/* One section, not two. "What is syncing" and "what could sync" are
            the same question asked from either end, and splitting them put a
            provider's name on the screen twice. */}
        <section className="mt-14">
          <SectionHeading
            title="Connected sources"
            description="A source is copied in and re-read on a schedule, so a bundle stays right after the month somebody filled it."
          />

          <div className="mt-6 flex flex-col gap-2.5">
            {connections.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : live.length > 0 ? (
              live.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))
            ) : (
              <EmptyState
                title="Nothing is syncing yet."
                description="A connected source re-reads itself on a schedule, so a bundle stays right after the month somebody filled it."
              />
            )}
          </div>

          <div className="mt-8">
            <PanelEyebrow>Add a source</PanelEyebrow>
            {bundles.length === 0 ? (
              <div className="mt-2.5">
                <EmptyState
                  title="Make a bundle first."
                  description={
                    <>
                      A connection keeps a bundle current, so there has to be one to keep. Create
                      one on an agent's <Link to="/">Knowledge tab</Link>.
                    </>
                  }
                />
              </div>
            ) : (
              // Side by side rather than stacked: two providers as two
              // full-width cards read as two decisions, and they are one.
              <div className="mt-2.5 grid gap-2.5 lg:grid-cols-2">
                {providers.map((provider) => (
                  <ConnectSourceCard key={provider.id} provider={provider} bundles={bundles} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* A different idea from the section above, which is why it is its own.
            A source syncs documents into a bundle and the agent never speaks to
            it. A service is something the agent calls while it is answering —
            and the reason it is a form rather than a release is that the worker
            has no per-service code to go with it. */}
        <section className="mt-16">
          <SectionHeading
            title="Services an agent can call"
            description="A database, an API, or one of about fifteen hundred applications. An agent asks you before its first action on each."
          />

          <div className="mt-6 flex flex-col gap-2.5">
            {/* First, because it is the shortest road to most of what a team
                wants an agent to reach, and because the catalogue inside it is
                the thing somebody came to this page to use. */}
            <ComposioCard connections={tools.data?.connections ?? []} agents={agents} />

            {/* Second: everything somebody entered by hand. One card holding
                rows, rather than a card per connection stacked under the one
                above — which is what made this section unreadable. */}
            <SectionCard className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-dm text-title font-medium leading-tight">
                    Databases and APIs
                  </span>
                  <span className="text-meta leading-tight text-muted-foreground">
                    Anything with a base address and a token. No per-service code — a row.
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={() => setAddingService(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add
                </Button>
              </div>

              {tools.isPending ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : services.length > 0 ? (
                <ul className="flex flex-col gap-1.5 border-t border-hairline pt-4">
                  {services.map((connection) => (
                    <ToolConnectionCard key={connection.id} connection={connection} />
                  ))}
                </ul>
              ) : (
                <p className="border-t border-hairline pt-4 text-sm text-muted-foreground">
                  Nothing entered by hand. Connect a database or an API and an agent can go and look
                  something up while it answers — and schedule itself to do it again.
                </p>
              )}

              {availableTools.length > 0 ? <ToolList tools={availableTools} /> : null}
            </SectionCard>
          </div>
        </section>

        <section className="mt-16">
          <SectionHeading
            title="Where the answers go"
            description="The same retrieval, the same citations and the same allowance, asked for somewhere other than here."
          />
          <div className="mt-6 grid gap-2.5">
            {slack.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : slack.data ? (
              <SlackCard state={slack.data} agents={agents} />
            ) : null}

            {/* Two things that were already true before any of the above, and
                are still the honest description of them. Side by side, because
                neither is a decision — they are two sentences. */}
            <div className="grid gap-2.5 lg:grid-cols-2">
              <SurfaceCard
                mark={<Code2 className="h-[22px] w-[22px]" />}
                title="REST API"
                meta="Call any shared agent programmatically, with a key you mint in Settings."
              />
              <SurfaceCard
                mark={<SlackMark className="h-[22px] w-[22px]" />}
                title="Slack webhook"
                meta="Deliver a routine's results to a channel, through a webhook URL you paste in Settings."
              />
            </div>
          </div>
        </section>

        <p className="mt-16 max-w-[620px] text-sm leading-[1.45] text-muted-foreground">
          What each source can read, and what it deliberately cannot, is in{" "}
          <DocsLink page="integrations">the integrations guide</DocsLink>.
        </p>

        <p className="mt-4 max-w-[620px] text-sm leading-[1.45] text-muted-foreground">
          Scheduled work lives with each agent instead — see{" "}
          <Link to="/settings" className="text-foreground underline underline-offset-4">
            delivery channels
          </Link>{" "}
          in Settings for where routines send their updates.
        </p>
      </PageContainer>

      <AddServiceDialog open={addingService} onOpenChange={setAddingService} />
    </AppShell>
  );
}

/**
 * A way out that needs no setting up here, only saying.
 *
 * Both of these are configured in Settings and neither has a control on this
 * page, so they are one shape with two labels rather than two hand-written
 * cards that had drifted a class apart.
 */
function SurfaceCard({
  mark,
  title,
  meta,
}: {
  mark: React.ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <SectionCard className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
          {mark}
        </span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-dm text-title font-medium leading-tight">{title}</span>
          <span className="text-meta leading-tight text-muted-foreground">{meta}</span>
        </span>
      </div>
      <Chip tone="on">Available</Chip>
    </SectionCard>
  );
}
