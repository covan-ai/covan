import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { quotaFrom, approximateReplies } from "@/lib/quota";
import { SectionHeading } from "@/components/page-container";
import { SectionCard, DataRow, EmptyState } from "@/components/section-card";
import { AgentAvatar } from "@/components/avatars";
import { QuotaWall } from "@/components/quota-wall";
import { WorkspaceProviderKeys } from "@/components/workspace-provider-keys";

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
 * Every figure is the caller's own, and `workspace_usage` says so in its own
 * join (`0022`). It used to rely on RLS for that instead — sessions were
 * private per user, so the select policy did the scoping by itself — and when
 * `0008` added shared sessions the totals quietly began including colleagues'
 * conversations while this heading still said "Yours alone". A policy answers
 * "may this person see this row", which stopped being the same question as
 * "is this row theirs" the moment sharing existed.
 */
export function UsageSection() {
  const { data: usage, isLoading } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const quota = quotaFrom(usage);
  // Rounded the same way the composer's banner rounds it, so the two surfaces
  // cannot disagree by a digit that neither of them means.
  const shown = quota ? approximateReplies(quota.repliesLeft) : 0;
  const agents = usage?.agents ?? [];
  const used = agents.filter((a) => a.messageCount > 0);

  // `/usage` has no notion of a workspace provider key — `entitlements.snapshot`
  // (`worker/src/routes/usage.ts`) answers purely from the account's own
  // allowance, so it cannot say replies continue past it. Read here so the
  // sentence below can stop calling replies "paused" once an admin has made
  // that false. Shared by query key rather than passed down as a prop — the
  // same choice `["usage"]` itself makes — so this, `QuotaWall` and
  // `WorkspaceProviderKeys` all agree without any of them owning the others.
  //
  // No longer gated on being *spent*. It was, and that was the same mistake as
  // gating the key field itself: an admin with replies left needs the hint to
  // know whether their workspace already has a key, and the allowance is per
  // member, so "spent" is not a fact about the workspace at all.
  //
  // Still gated on the deployment being metered, which is the honest version of
  // what that gate was reaching for. `quota` is null on a self-hosted install,
  // where nothing below this line renders and a workspace key would fund
  // nothing — the same condition the whole card is behind. It is null while
  // `["usage"]` is in flight too, so this simply starts a moment later.
  const { data: keys } = useQuery({
    queryKey: ["provider-keys"],
    queryFn: () => api.providerKeys.get(),
    enabled: quota !== null,
  });
  const hasWorkspaceKey = Boolean(keys?.openai || keys?.anthropic);

  // Share of measured input that OpenAI served from its prompt cache. The
  // denominator is measuredPromptTokens, not promptTokens: replies stored
  // before the count existed report nothing, and dividing by every prompt ever
  // sent would show a rate that rises on its own as those age out rather than
  // because the cache improved. Null until there is a measured reply, and the
  // line below renders nothing at all in that window.
  const measured = usage?.totals.measuredPromptTokens ?? 0;
  const cacheRate = measured > 0 ? (usage?.totals.cachedTokens ?? 0) / measured : null;

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
              ? // "Paused" stopped being true the moment an admin saved a
                // workspace key below — echoing `quota-wall.tsx`'s own
                // "carries on from here" rather than inventing a second phrase
                // for the same fact.
                hasWorkspaceKey
                ? "Used up — the workspace's own key carries on from here"
                : "Used up — new replies are paused"
              : `About ${shown} ${shown === 1 ? "reply" : "replies"} left`}
            {quota.resetsOn ? ` · resets on ${quota.resetsOn}` : null}
          </p>
          {/* Door one, in both states, and only for an admin — the component
              decides that for itself. It cannot hang off `level` the way the
              wall below does: the allowance is per member, so the person who
              hits the wall and the person who can do something about it are
              usually not the same person. An admin who is told about this only
              after burning their own month is an admin who is told too late,
              and until they are, the key their workspace already stored cannot
              be removed either. */}
          <WorkspaceProviderKeys />

          {/* The rest of the wall, only once it is actually spent. Somebody
              with replies left does not need to be told there is somewhere
              else to go, and this is a fact rather than a nudge: the allowance
              exists because the operator is paying OpenAI, and an install
              running on your own key does not have one. Waiting used to be
              weighed against exactly one other option — self-hosting — and is
              now weighed against three: the workspace's own key, a message to
              us, and self-hosting still, nearest first. See `quota-wall.tsx`. */}
          {quota.level === "spent" && <QuotaWall />}

          <p className="mt-3 border-t border-hairline pt-3 text-xs text-muted-foreground">
            Counted in tokens, the unit the model is billed in, and converted to replies at about{" "}
            {compact(quota.perReply)} tokens each.{" "}
            {quota.repliesSeen === 0
              ? "That is a starting assumption until you have sent something; it shifts towards what your own replies actually cost as you go."
              : "That is mostly what your own replies have cost, weighed against a starting assumption that fades as you send more."}{" "}
            A long conversation with documents attached costs more than a short question, so the
            estimate moves.
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
        {cacheRate !== null && (
          <>
            {" "}
            About {Math.round(cacheRate * 100)}% of your input was already in the model's cache and
            billed at a reduced rate — carrying on an existing conversation caches well, while a new
            one always starts cold.
          </>
        )}
      </p>
    </section>
  );
}
