import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Code2, MessageSquare } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { Chip, EmptyState, SectionCard } from "@/components/section-card";
import { DocsLink } from "@/components/docs-link";
import { ConnectionCard, ConnectSourceCard } from "@/components/integrations/connection-card";
import { SlackCard } from "@/components/integrations/slack-card";
import { useConnections, useSlack } from "@/hooks/use-connections";
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
    const error = params.get("error");
    if (!connected && !error) return;

    if (connected) {
      toast.success(`${CONNECTED_LABEL[connected] ?? connected} connected.`);
    } else if (error) {
      toast.error(connectErrorMessage(error));
    }

    window.history.replaceState({}, "", window.location.pathname);
  }, []);
}

function IntegrationsPage() {
  useGrantOutcome();

  const connections = useConnections();
  const slack = useSlack();
  const { bundles, agents } = useAgentsStore();

  const live = connections.data?.connections ?? [];
  // Every provider is offered every time, connected or not: one team's Notion
  // feeds three bundles, and deciding for them which of those is "enough" is
  // not a judgement this page can make.
  const providers = connections.data?.providers ?? [];

  return (
    <AppShell>
      <PageContainer width="list">
        <PageHeader
          badge="Integrations"
          title="Where the knowledge comes from."
          turn="And where the answers go."
        />

        <section className="mt-14">
          <SectionHeading title="Connected sources" />
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
        </section>

        <section className="mt-16">
          <SectionHeading title="Add a source" />
          {bundles.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                title="Make a bundle first."
                description={
                  <>
                    A connection keeps a bundle current, so there has to be one to keep. Create one
                    on an agent's <Link to="/">Knowledge tab</Link>.
                  </>
                }
              />
            </div>
          ) : (
            <div className="mt-6 grid gap-2.5">
              {providers.map((provider) => (
                <ConnectSourceCard key={provider.id} provider={provider} bundles={bundles} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-16">
          <SectionHeading title="Where the answers go" />
          <div className="mt-6 grid gap-2.5">
            {slack.isPending ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : slack.data ? (
              <SlackCard state={slack.data} agents={agents} />
            ) : null}

            {/* Two things that were already true before any of the above, and
                are still the honest description of them. */}
            <SectionCard className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
                  <Code2 className="h-[22px] w-[22px]" />
                </span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-dm text-[18px] font-medium leading-tight">REST API</span>
                  <span className="text-[13px] leading-tight text-muted-foreground">
                    Call any shared agent programmatically, with a key you mint in Settings.
                  </span>
                </span>
              </div>
              <Chip tone="on">Available</Chip>
            </SectionCard>

            <SectionCard className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
                  <MessageSquare className="h-[22px] w-[22px]" />
                </span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-dm text-[18px] font-medium leading-tight">
                    Slack webhook
                  </span>
                  <span className="text-[13px] leading-tight text-muted-foreground">
                    Deliver a routine's results to a channel, through a webhook URL you paste in
                    Settings.
                  </span>
                </span>
              </div>
              <Chip tone="on">Available</Chip>
            </SectionCard>
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
    </AppShell>
  );
}
