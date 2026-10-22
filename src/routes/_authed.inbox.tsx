import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { PageBody } from "@/components/page";
import { Pills } from "@/components/pills";
import { EmptyPage } from "@/components/empty-page";
import { InboxRow } from "@/components/inbox-row";
import { NewThreadButton } from "@/components/new-thread-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInbox, useMarkAllRead, useMarkRead } from "@/hooks/use-inbox";
import { useAgentsStore } from "@/lib/agents-store";
import { groupByDay } from "@/lib/day-groups";
import type { InboxFilter } from "@/lib/api-client";

const FILTERS: InboxFilter[] = ["all", "unread", "needs_you", "running", "mine"];

type InboxSearch = { filter?: InboxFilter; agent?: string };

export const Route = createFileRoute("/_authed/inbox")({
  component: InboxPage,
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    filter: FILTERS.includes(search.filter as InboxFilter)
      ? (search.filter as InboxFilter)
      : undefined,
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  head: () => ({ meta: [{ title: "Inbox — Covan" }] }),
});

/**
 * The Inbox (A4, A20): every thread with something new in it, what waits on
 * you first, under date eyebrows. Opening a row reads it.
 */
function InboxPage() {
  const { filter = "all", agent } = Route.useSearch();
  const navigate = useNavigate();
  const { agents } = useAgentsStore();
  const { data, isPending } = useInbox(filter, agent);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const counts = data?.counts ?? { unread: 0, needsYou: 0, running: 0 };
  const byId = new Map(agents.map((a) => [a.id, a]));
  const set = (next: InboxSearch) =>
    void navigate({ to: "/inbox", search: { filter, agent, ...next }, replace: true });

  const meta = [
    counts.unread > 0 ? `${counts.unread} unread` : null,
    counts.running > 0 ? `${counts.running} running` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <TopBar
        title="Inbox"
        meta={meta || undefined}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={counts.unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              Mark all read
            </Button>
            <NewThreadButton />
          </>
        }
        phoneActions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
            >
              <Search />
            </Button>
            <NewThreadButton variant="secondary" iconOnly />
          </>
        }
      />
      <PageBody width="list" className="lg:pt-4">
        <div className="flex flex-wrap items-center gap-2 lg:px-3">
          <Pills
            label="Show"
            value={filter}
            onChange={(f) => set({ filter: f === "all" ? undefined : f })}
            options={[
              { value: "all", label: "All" },
              { value: "unread", label: "Unread", count: counts.unread },
              { value: "needs_you", label: "Needs you", count: counts.needsYou },
              { value: "running", label: "Running", count: counts.running },
              { value: "mine", label: "Mine" },
            ]}
          />
          <span className="flex-1" />
          {agents.length > 1 && (
            <Select
              value={agent ?? "all"}
              onValueChange={(v) => set({ agent: v === "all" ? undefined : v })}
            >
              <SelectTrigger aria-label="Agent" className="w-auto min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {isPending ? (
          <p className="mt-8 text-sm text-muted-foreground lg:px-3">Loading…</p>
        ) : !data || data.items.length === 0 ? (
          <EmptyPage
            dot="done"
            title="Nothing needs you"
            description="When an agent asks a question, finishes a job or a routine fails, it shows up here. You will also get an email if you are away for an hour."
            actions={
              <>
                <NewThreadButton variant="secondary" />
                <Button asChild variant="secondary">
                  <Link to="/threads">All threads</Link>
                </Button>
              </>
            }
          />
        ) : (
          <>
            {groupByDay(data.items, (i) => i.lastActivityAt).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="m-0 px-3 pt-5 pb-1.5 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase max-lg:px-0">
                  {g.label}
                </h2>
                {g.items.map((item) => (
                  <InboxRow
                    key={item.sessionId}
                    item={item}
                    agent={byId.get(item.agentId)}
                    onOpen={(i) => {
                      if (i.unread) markRead.mutate(i.sessionId);
                    }}
                  />
                ))}
              </section>
            ))}
            <div className="mt-6 text-center">
              <Link
                to="/threads"
                className="text-meta font-medium text-muted-foreground hover:text-foreground"
              >
                Older threads
              </Link>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
