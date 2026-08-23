import { createFileRoute, Link } from "@tanstack/react-router";
import { Code2, FolderGit2, MessageSquare, NotebookPen, type LucideIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { Chip } from "@/components/section-card";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/integrations")({
  component: IntegrationsPage,
  head: () => ({
    meta: [
      { title: "Integrations — Covan" },
      { name: "description", content: "Connect your team's tools and APIs." },
    ],
  }),
});

type Status = "available" | "beta" | "soon";

type Integration = {
  name: string;
  desc: string;
  icon: LucideIcon;
  status: Status;
};

const items: Integration[] = [
  {
    name: "REST API",
    desc: "Call any shared agent programmatically, with the same knowledge it uses in chat.",
    icon: Code2,
    status: "beta",
  },
  {
    // Shipped, but narrower than "Slack" sounds: an incoming-webhook URL you
    // paste into Settings, which routines post their results to. There is no
    // Slack app and no OAuth, so nothing reads *from* Slack — and the earlier
    // "send agent replies" half of this entry described the connector below
    // rather than anything that exists.
    name: "Slack webhook",
    desc: "Deliver a routine's results to a channel, through a webhook URL you paste in Settings.",
    icon: MessageSquare,
    status: "available",
  },
  {
    name: "Slack app",
    desc: "Reply to an agent from a channel, without leaving Slack.",
    icon: MessageSquare,
    status: "soon",
  },
  {
    name: "Notion",
    desc: "Sync docs into a knowledge bundle so agents stay current.",
    icon: NotebookPen,
    status: "soon",
  },
  {
    name: "GitHub",
    desc: "Attach repositories as context for engineering agents.",
    // A repository, not the GitHub mark. lucide 1 dropped its brand icons, and
    // this page never wanted one: Slack is a MessageSquare and Notion is a
    // NotebookPen, so the logo was the odd entry out rather than the pattern.
    icon: FolderGit2,
    status: "soon",
  },
];

/**
 * Neutral grey = off, pending, or coming soon. Amber = shipped. That is the
 * whole vocabulary — there is no third state and no red (§7.8), which is
 * exactly right for a page whose job is to be honest about what is built.
 */
function StatusChip({ status }: { status: Status }) {
  // "Available", not "Connected": this list says what Covan can do, not what
  // this workspace has set up. Whether a webhook URL actually exists is a
  // question for Settings, and answering it here would be a guess.
  const label = status === "beta" ? "Beta" : status === "available" ? "Available" : "Coming soon";
  return <Chip tone={status === "soon" ? "neutral" : "on"}>{label}</Chip>;
}

function IntegrationsPage() {
  const live = items.filter((i) => i.status !== "soon");
  const soon = items.filter((i) => i.status === "soon");

  return (
    <AppShell>
      <PageContainer width="list">
        <PageHeader
          badge="Integrations"
          title="The API is here."
          turn="The connectors are coming."
        />

        <section className="mt-14">
          <SectionHeading title="Available now" />
          <IntegrationList items={live} />
        </section>

        <section className="mt-16">
          <SectionHeading title="On the roadmap" />
          <IntegrationList items={soon} />
        </section>

        <p className="mt-16 max-w-[620px] text-sm leading-[1.45] text-muted-foreground">
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

function IntegrationList({ items }: { items: Integration[] }) {
  return (
    <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div
            key={it.name}
            className={cn(
              "flex flex-col gap-3 rounded-xl border border-border bg-surface p-5",
              // An unbuilt connector is dimmed rather than hidden — the row
              // still reads, it just stops competing (§7.8, `.brow--off`).
              it.status === "soon" && "opacity-70",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              {/* A brand mark lives in a 44px tile — the accent ceiling. */}
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground ring-1 ring-inset ring-hairline">
                <Icon className="h-[22px] w-[22px]" />
              </span>
              <StatusChip status={it.status} />
            </div>
            <div>
              <div className="font-dm text-[18px] font-medium leading-tight">{it.name}</div>
              <p className="mt-1.5 text-sm leading-[1.45] text-muted-foreground">{it.desc}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
