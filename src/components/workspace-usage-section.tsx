import { useQuery } from "@tanstack/react-query";
import { api, type UsageMonth } from "@/lib/api-client";
import { SectionHeading } from "@/components/page-container";
import { SectionCard, DataRow, EmptyState } from "@/components/section-card";
import { AgentAvatar } from "@/components/avatars";

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);

const usd = (n: number) => (n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

const monthLabel = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    timeZone: "UTC",
  });

/**
 * What the whole workspace costs, for the person holding the invoice.
 *
 * The section above it is the caller's own and says so. This one is everyone's,
 * and says that too — two figures on one screen that mean different things have
 * to be labelled apart, which is the same reason the allowance and the lifetime
 * totals above are under separate headings.
 *
 * **By agent and by month, never by person.** That is not a rule this component
 * follows; it is the only thing it can do. `workspace_usage_all` does not
 * select, group by or return a `user_id`, so there is no per-person breakdown
 * to render even if a later screen wanted one. See `0032`.
 *
 * Rendered only for an admin, and only once the migration behind it exists —
 * `available: false` is the window between deploying the API and hand-applying
 * `0032`, and an admin should see nothing rather than an error about a feature
 * they never asked for.
 */
export function WorkspaceUsageSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["usage", "workspace"],
    queryFn: api.workspaceUsage,
  });

  if (isLoading || !data?.available) return null;

  const used = data.agents.filter((a) => a.messageCount > 0);
  const months = data.months;

  return (
    <section className="mt-16">
      <SectionHeading
        title="The workspace"
        description="Everyone's conversations together, by agent — never by person."
      />

      {months.length > 0 && <MonthlyTrend months={months} />}

      <SectionCard padded={false} className="mt-3 overflow-hidden">
        {used.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Once anybody talks to an agent, what the workspace spends shows up here."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {used.map((a) => (
              <li key={a.agentId}>
                <DataRow
                  icon={<AgentAvatar emoji={a.emoji ?? "🤖"} className="h-8 w-8 text-sm" />}
                  title={a.name}
                  meta={`${a.messageCount} ${a.messageCount === 1 ? "reply" : "replies"} · ${a.model}`}
                  trailing={
                    <span className="text-right text-xs text-muted-foreground">
                      <span className="block font-medium text-foreground">
                        {compact(a.totalTokens)}
                      </span>
                      {usd(a.estCostUsd)}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <p className="mt-3 text-xs text-muted-foreground">
        Everything anybody in this workspace has ever asked, at list prices. The model shown is the
        agent's current one, and it prices every reply that agent has ever sent — changing an
        agent's model re-prices its history, because a reply does not record which model wrote it.
        Nothing here is broken down by person, and there is no view that does.
      </p>
    </section>
  );
}

/**
 * Six months of tokens, in the system's own vocabulary: squares, one amber
 * fill, no chart library. Everything the product shows is otherwise either a
 * lifetime total or the current month, so this is the only place that answers
 * "are we spending more than we were".
 *
 * A month nobody used is a zero rather than a gap — `workspace_usage_monthly`
 * generates the span so a quiet month cannot silently close up and make a fall
 * look like a flat line.
 */
function MonthlyTrend({ months }: { months: UsageMonth[] }) {
  const peak = Math.max(...months.map((m) => m.totalTokens), 1);

  return (
    <SectionCard className="mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-muted-foreground">Last {months.length} months</span>
        <span className="text-sm font-medium">
          {compact(months.reduce((n, m) => n + m.totalTokens, 0))} tokens
        </span>
      </div>

      <div className="mt-4 flex items-end gap-2">
        {months.map((m) => (
          <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
            {/* 64px of headroom, and a 2px floor so an empty month still reads
                as a month rather than as missing. */}
            <div className="flex h-16 w-full items-end" title={`${compact(m.totalTokens)} tokens`}>
              <div
                className="w-full bg-accent-orange"
                style={{ height: `${Math.max(2, Math.round((m.totalTokens / peak) * 100))}%` }}
                aria-hidden
              />
            </div>
            <span className="text-[11px] text-muted-foreground">{monthLabel(m.month)}</span>
          </div>
        ))}
      </div>

      {/* The bars are decoration; this is the same data in a form a screen
          reader can read out. */}
      <ul className="sr-only">
        {months.map((m) => (
          <li key={m.month}>
            {monthLabel(m.month)}: {m.totalTokens} tokens across {m.messageCount} replies
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
