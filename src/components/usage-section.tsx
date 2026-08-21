import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { quotaFrom } from "@/lib/quota";
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

/**
 * What this account has used, on the one screen with room to say it properly.
 *
 * Two different windows are shown, and they are labelled apart on purpose: the
 * allowance is a calendar month, while the per-agent figures below cover every
 * conversation ever. Putting both under one heading would make the numbers look
 * like they should add up, and they never will.
 *
 * Every figure is the caller's own. Chat sessions are private per user and row
 * level security scopes the aggregate to the caller, so this is not a view of
 * what the team is doing.
 */
export function UsageSection() {
  const { data: usage, isLoading } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const quota = quotaFrom(usage);
  const agents = usage?.agents ?? [];
  const used = agents.filter((a) => a.messageCount > 0);

  return (
    <section className="mt-16">
      <SectionHeading
        title="Usage"
        description="Yours alone — your conversations are private, and so are these figures."
      />

      {quota && (
        <SectionCard className="mt-6">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm text-muted-foreground">This month</span>
            <span className="text-sm font-medium">
              {compact(quota.used)} of {compact(quota.limit)}
            </span>
          </div>

          {/* Squares, not pills — the bar follows the same rule as the rest of
              the system's marks (DESIGN.md §3). */}
          <div className="mt-3 h-1.5 w-full bg-muted" aria-hidden>
            <div
              className={
                quota.level === "fine" ? "h-full bg-foreground" : "h-full bg-accent-orange"
              }
              style={{ width: `${Math.max(2, Math.round(quota.ratio * 100))}%` }}
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {quota.level === "spent"
              ? "Used up — new replies are paused"
              : `About ${quota.repliesLeft} ${quota.repliesLeft === 1 ? "reply" : "replies"} left`}
            {quota.resetsOn ? ` · resets on ${quota.resetsOn}` : null}
          </p>
          <p className="mt-3 border-t border-hairline pt-3 text-xs text-muted-foreground">
            Counted in tokens, the unit the model is billed in, and converted to replies using what
            your own replies have cost so far — currently about {compact(quota.perReply)} tokens
            each. A long conversation with documents attached costs more than a short question, so
            the estimate moves.
          </p>
        </SectionCard>
      )}

      <SectionCard padded={false} className="mt-3 overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : used.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Once you start talking to an agent, what it costs shows up here."
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
        Per-agent figures cover every conversation you have had, not just this month, so they will
        not add up to the allowance above. Costs are estimates from list prices.
      </p>
    </section>
  );
}
