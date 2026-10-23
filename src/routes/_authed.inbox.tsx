import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { lookup, msg, useTranslation } from "@/i18n";
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
import { groupByDay, type DayGroup } from "@/lib/day-groups";
import type { InboxFilter } from "@/lib/api-client";

const FILTERS: InboxFilter[] = ["all", "unread", "needs_you", "running", "mine"];

/** `groupByDay` hands back its eyebrows as keys; declared here so the catalogue has them. */
const DAY_LABELS: Record<DayGroup<unknown>["label"], string> = {
  Today: msg("Today"),
  Yesterday: msg("Yesterday"),
  Earlier: msg("Earlier"),
};

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
  const { t } = useTranslation();
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
    counts.unread > 0
      ? t("{{count}} unread", { count: counts.unread, defaultValue_other: "{{count}} unread" })
      : null,
    counts.running > 0
      ? t("{{count}} running", { count: counts.running, defaultValue_other: "{{count}} running" })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <TopBar
        title={t("Inbox")}
        meta={meta || undefined}
        phoneMeta={counts.unread > 0 ? counts.unread : undefined}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={counts.unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              {t("Mark all read")}
            </Button>
            <NewThreadButton />
          </>
        }
        phoneActions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Search")}
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
            >
              <Search />
            </Button>
            <NewThreadButton variant="ghost" iconOnly />
          </>
        }
      />
      <PageBody width="list" className="lg:px-7 lg:pt-4">
        <div className="flex flex-wrap items-center gap-2 lg:px-3">
          <Pills
            label={t("Show")}
            value={filter}
            onChange={(f) => set({ filter: f === "all" ? undefined : f })}
            options={[
              { value: "all", label: t("All") },
              { value: "unread", label: t("Unread"), count: counts.unread },
              { value: "needs_you", label: t("Needs you"), count: counts.needsYou },
              { value: "running", label: t("Running"), count: counts.running },
              { value: "mine", label: t("Mine") },
            ]}
          />
          <span className="flex-1" />
          {agents.length > 1 && (
            <Select
              value={agent ?? "all"}
              onValueChange={(v) => set({ agent: v === "all" ? undefined : v })}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("Agent")}
                className="w-auto min-w-32 max-lg:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">{t("All agents")}</SelectItem>
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
          <p className="mt-8 text-sm text-muted-foreground lg:px-3">{t("Loading…")}</p>
        ) : !data || data.items.length === 0 ? (
          <EmptyPage
            dot="done"
            title={t("Nothing needs you")}
            description={t(
              "When an agent asks a question, finishes a job or a routine fails, it shows up here. You will also get an email if you are away for an hour.",
            )}
            actions={
              <>
                <NewThreadButton variant="secondary" />
                <Button asChild variant="secondary">
                  <Link to="/threads">{t("All threads")}</Link>
                </Button>
              </>
            }
          />
        ) : (
          <>
            {groupByDay(data.items, (i) => i.lastActivityAt).map((g) => (
              <section key={g.label} aria-label={lookup(t, DAY_LABELS[g.label])}>
                <h2 className="m-0 px-3 pt-5 pb-1.5 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase max-lg:px-0">
                  {lookup(t, DAY_LABELS[g.label])}
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
                {t("Older threads")}
              </Link>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
