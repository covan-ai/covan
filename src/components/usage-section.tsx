import { useQuery } from "@tanstack/react-query";
import { api, type AgentUsage } from "@/lib/api-client";
import { creditsFrom, approximateReplies, wholeCredits, creditsPhrase } from "@/lib/credits";
import { SectionHeading } from "@/components/page-container";
import { SectionCard, DataRow, Disclosure, EmptyState } from "@/components/section-card";
import { AgentAvatar } from "@/components/avatars";
import { CreditsWall } from "@/components/credits-wall";

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);

// `<$0.01` is for an amount too small to print, not for the absence of one: a
// month or an agent that really spent nothing reads `$0.00`, because "<$0.01"
// under 0 replies says money moved and none did.
const usd = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * What this workspace has left, and what this person has used.
 *
 * Two different things, labelled apart on purpose. Credits belong to the
 * workspace — one pool every member spends from — while the per-agent figures
 * below are the caller's own conversations, ever. Putting both under one
 * heading would make the numbers look like they should add up, and they never
 * will.
 *
 * Every per-agent figure is the caller's own, and `workspace_usage` says so in
 * its own join (`0022`). It used to rely on RLS for that instead — sessions
 * were private per user — and when `0008` added shared sessions the totals
 * quietly began including colleagues' conversations while this heading still
 * said "Yours alone". A policy answers "may this person see this row", which
 * stopped being the same question as "is this row theirs" the moment sharing
 * existed.
 */
export function UsageSection() {
  const { data: usage, isLoading } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const credits = creditsFrom(usage);
  // Rounded the same way the composer's banner rounds it, so the two surfaces
  // cannot disagree by a digit that neither of them means.
  const shown = credits ? approximateReplies(credits.repliesLeft) : 0;
  const agents = usage?.agents ?? [];
  const used = agents.filter((a) => a.messageCount > 0);

  // Credits on the hosted service, dollars on an install that has none — one
  // unit per screen, never both. The server decides which by sending
  // `estCredits` or not; a hosted row the API has not quoted shows no money
  // rather than falling back to dollars.
  const hosted = usage?.credits.metered === true;
  const money = (a: AgentUsage) =>
    hosted
      ? typeof a.estCredits === "number"
        ? creditsPhrase(a.estCredits)
        : null
      : usd(a.estCostUsd);

  // Share of measured input that the provider served from its prompt cache.
  // The denominator is measuredPromptTokens, not promptTokens: replies stored
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
        description="Credits are the workspace's. The figures below them are yours alone."
      />

      {credits && (
        <SectionCard className="mt-6">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm text-muted-foreground">Workspace credits</span>
            <span className="text-sm font-medium">
              {credits.balance > 0 && credits.balance < 1
                ? "<1"
                : wholeCredits(credits.balance).toLocaleString()}{" "}
              of {wholeCredits(credits.granted).toLocaleString()}
            </span>
          </div>

          {/* Squares, not pills — the bar follows the same rule as the rest of
              the system's marks (DESIGN.md §3). Amber once it is worth a look. */}
          <div className="mt-3 h-1.5 w-full bg-muted" aria-hidden>
            <div
              className={credits.level === "fine" ? "h-full bg-foreground" : "h-full bg-brand"}
              style={{ width: `${Math.max(2, Math.round(credits.ratio * 100))}%` }}
            />
          </div>

          {/* The replies estimate only once it has something to stand on
              (`repliesKnown`) — or once the balance is low, where even a rough
              number is what somebody plans around. */}
          {credits.level === "spent" ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Out of credits — new replies are paused until more are added
            </p>
          ) : credits.level === "low" || credits.repliesKnown ? (
            <p className="mt-3 text-xs text-muted-foreground">
              About {shown.toLocaleString()} {shown === 1 ? "reply" : "replies"} left
            </p>
          ) : null}

          {/* The rest of the wall, only once it is actually spent. Somebody
              with credits left does not need to be told there is somewhere
              else to go. See `credits-wall.tsx`. */}
          {credits.level === "spent" && <CreditsWall />}

          <p className="mt-3 border-t border-hairline pt-3 text-xs text-muted-foreground">
            Credits are what every piece of work here is charged in — a reply, indexing a document,
            a connected-app call, a browser task. Every member of the workspace spends from the same
            balance.
          </p>
          <Disclosure className="mt-2" label="Where the reply estimate comes from">
            {!credits.repliesKnown && credits.level === "fine"
              ? "An estimate of how many replies are left appears once this workspace has sent about ten. Until then the only honest number is the balance: a single cheap question would swing an average of two or three."
              : credits.repliesSeen === 0
                ? "It is a starting assumption until this workspace has sent something, and shifts towards what its own replies actually cost as you go."
                : "It is mostly what this workspace's own replies have cost, weighed against a starting assumption that fades as you send more."}{" "}
            A long conversation with documents attached costs more than a short question, and a
            browser task or a connected app costs credits of its own, so the estimate moves.
          </Disclosure>
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
                      {money(a)}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {/* Both sentences stay: the first is why these figures do not reconcile
          with the credits above, and the second is what backs the money. */}
      <p className="mt-3 text-xs text-muted-foreground">
        Per-agent figures cover every conversation you have had, and are estimates from list prices
        {hosted ? " at today's rate" : ""}.{" "}
        {hosted
          ? "The balance above is what was actually charged, to the whole workspace."
          : "Nothing here is charged to anyone: a self-hosted install pays its providers directly."}
      </p>
      {cacheRate !== null && (
        <Disclosure
          className="mt-2"
          label={`${Math.round(cacheRate * 100)}% of your input was cached`}
        >
          Cached input is billed at a reduced rate. Carrying on an existing conversation caches
          well, while a new one always starts cold.
        </Disclosure>
      )}
    </section>
  );
}
