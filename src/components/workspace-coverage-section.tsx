import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CoverageAgent, type CoverageTotals } from "@/lib/api-client";
import { SectionHeading } from "@/components/page-container";
import { SectionCard, DataRow, Chip, EmptyState } from "@/components/section-card";
import { AgentAvatar } from "@/components/avatars";
import { Button } from "@/components/ui/button";

const WINDOWS = [7, 30, 90] as const;

/**
 * The share an agent has to miss before it is worth pointing at.
 *
 * A third is not a threshold anybody derived; it is the point past which the
 * honest sentence changes. Below it, "some questions were not covered" is
 * ordinary and always will be — people ask about things no handbook has. Above
 * it, most of what this agent is being asked is not in what it was given, and
 * that is a different fact about the workspace.
 */
const MISS_SHARE_WORTH_POINTING_AT = 0.33;

const pct = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 100));

/**
 * What the team asked that nothing written was close to.
 *
 * `messages.grounding` (0039) has recorded, on every reply, which of three
 * ways it was grounded — a passage that cleared the similarity floor, the
 * whole-document fallback, or nothing. `0053` reads it back by agent and by
 * window. This is the screen.
 *
 * **The middle bucket is the feature.** A reply that fell back to whole
 * documents is usually still a good answer, and it means no passage in
 * anything the team wrote was close to what was asked. That is the question
 * the team keeps asking that nobody has written down, and unlike a token
 * count it is a thing an admin can act on in an afternoon.
 *
 * **By agent and by window, never by person and never the question itself.**
 * The functions behind this do not select a `user_id` and return no content,
 * so there is nothing per-person to render even if a later screen wanted it.
 * Listing the questions themselves is a separate feature and needs the consent
 * of whoever asked — a count cannot identify anybody; the sentence they typed
 * can. See the header of `0053`.
 *
 * Rendered only for an admin, and only once the migration behind it exists:
 * `available: false` is the window between deploying the API and hand-applying
 * `0053`, and an admin should see nothing rather than an error about a feature
 * they never asked for. Same arrangement as `WorkspaceUsageSection`.
 */
export function WorkspaceCoverageSection() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading } = useQuery({
    queryKey: ["coverage", "workspace", days],
    queryFn: () => api.coverage(days),
  });

  // No spinner on a switch: `keepPreviousData` is not in use here, so the only
  // loading state that reaches the eye is the first one, and a section that
  // appears mid-scroll is worse than a section that appears a moment late.
  if (isLoading || !data?.available) return null;

  const { totals, agents } = data;
  // `0053` returns every agent in the workspace, including the ones nobody
  // asked anything in this window. They are not rows — a list of zeroes buries
  // the agents that have figures — but they are not nothing either, so they
  // are counted in one line under the list.
  const asked = agents.filter((a) => a.answers > 0);
  const untouched = agents.length - asked.length;

  return (
    <section className="mt-16">
      <SectionHeading
        title="What nothing was close to."
        description="Every reply records whether a passage your team wrote actually matched the question. This is that, by agent — never by person, and never the question itself."
        action={<WindowPicker days={days} onChange={setDays} />}
      />

      {totals.answers === 0 ? (
        // Bare, not inside a card. The empty state is already a well with its
        // own 12px radius, and a 12px child inside a 12px parent is the radius
        // mistake DESIGN.md lists fourth.
        <EmptyState
          className="mt-6"
          title="Nothing in this window"
          description={
            totals.unrecorded > 0
              ? `${totals.unrecorded} ${totals.unrecorded === 1 ? "reply" : "replies"} here predate this being recorded. Once somebody asks an agent a question, how it was grounded lands here.`
              : "Once somebody asks an agent a question, whether anything you wrote was close to it lands here."
          }
        />
      ) : (
        <>
          <CoverageSummary totals={totals} days={days} />
          <AgentBreakdown agents={asked} />
        </>
      )}

      {untouched > 0 && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          {untouched} {untouched === 1 ? "agent" : "agents"} nobody asked anything in this window.
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        A reply that fell back to whole documents is usually still a good answer — it means no
        passage in your knowledge was a close match for what was asked, which is the gap worth
        writing something for. A reply with nothing to stand on is a different problem: that agent
        has no usable documents attached.
        {totals.unrecorded > 0
          ? ` ${totals.unrecorded} ${totals.unrecorded === 1 ? "reply" : "replies"} in this window predate the recording and are left out of every figure above.`
          : ""}
      </p>
    </section>
  );
}

/**
 * Three windows, as buttons rather than a select.
 *
 * Three options is under the count where a select earns its extra click, and a
 * row of buttons is reachable by keyboard and readable at 375px without
 * opening anything. `aria-pressed` carries the state that the ink fill shows.
 */
function WindowPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {WINDOWS.map((w) => (
        <Button
          key={w}
          type="button"
          size="sm"
          variant={w === days ? "secondary" : "ghost"}
          aria-pressed={w === days}
          onClick={() => onChange(w)}
        >
          {w}d
        </Button>
      ))}
    </div>
  );
}

/**
 * The headline figure and the split behind it.
 *
 * The bar is ink and muted rather than ink and amber. Amber is a pointer in
 * this system and nothing amber may be larger than 44px (DESIGN.md §1); a
 * third of a full-width bar is not a pointer, it is a wall. So the bar states
 * the proportion in neutrals and the amber is spent, at most once on this
 * screen, on the one agent worth acting on.
 */
function CoverageSummary({ totals, days }: { totals: CoverageTotals; days: number }) {
  const coveredPct = pct(totals.covered, totals.answers);

  return (
    <SectionCard className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="font-dm text-[32px] leading-none tabular-nums">{coveredPct}%</span>
        <span className="text-sm text-muted-foreground">
          of {totals.answers} {totals.answers === 1 ? "reply" : "replies"} in the last {days} days
          stood on something you wrote
        </span>
      </div>

      {/* One bar, three shares, in the order the legend reads them. Decoration:
          the same numbers are spelled out underneath. */}
      <div className="mt-5 flex h-2 w-full overflow-hidden rounded-sm bg-muted" aria-hidden>
        <div
          className="bg-foreground"
          style={{ width: `${pct(totals.covered, totals.answers)}%` }}
        />
        <div
          className="bg-foreground/35"
          style={{ width: `${pct(totals.fallback, totals.answers)}%` }}
        />
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        <Bucket
          swatch="bg-foreground"
          label="Stood on a passage"
          count={totals.covered}
          share={pct(totals.covered, totals.answers)}
        />
        <Bucket
          swatch="bg-foreground/35"
          label="Fell back to whole documents"
          count={totals.fallback}
          share={pct(totals.fallback, totals.answers)}
        />
        <Bucket
          swatch="bg-muted"
          label="Nothing to stand on"
          count={totals.ungrounded}
          share={pct(totals.ungrounded, totals.answers)}
        />
      </dl>
    </SectionCard>
  );
}

/** One share of the bar, named. The swatch is a square, per DESIGN.md §1.3. */
function Bucket({
  swatch,
  label,
  count,
  share,
}: {
  swatch: string;
  label: string;
  count: number;
  share: number;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-[2px] ${swatch}`} aria-hidden />
      <div className="min-w-0">
        <dt className="text-[13px] leading-tight text-muted-foreground">{label}</dt>
        <dd className="text-[15px] font-medium leading-tight tabular-nums">
          {count} <span className="text-muted-foreground">· {share}%</span>
        </dd>
      </div>
    </div>
  );
}

/**
 * The same figures per agent, worst first.
 *
 * The workspace number on its own does not say what to do: one agent starved
 * of documents drags the whole rate down and looks, from the total alone, like
 * a knowledge problem everywhere. `0053` orders by the misses, so the agent
 * most in need of somebody writing something down is at the top and this
 * renderer keeps that order rather than imposing its own.
 *
 * **One amber chip at most, and only on the first row.** Every row carries its
 * share; only the worst one — and only if it is past the threshold — carries
 * the accent. Amber is a pointer in this system (DESIGN.md §1), and a pointer
 * aimed at five rows at once is a highlight, which is a different thing and a
 * worse one. The rows below the first are not less true, they are just not
 * where to start.
 */
function AgentBreakdown({ agents }: { agents: CoverageAgent[] }) {
  if (agents.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-col gap-2.5">
      {agents.map((a, i) => {
        const missed = a.fallback + a.ungrounded;
        const share = pct(missed, a.answers);
        const worthPointingAt = i === 0 && missed / a.answers >= MISS_SHARE_WORTH_POINTING_AT;

        return (
          <li key={a.agentId}>
            <DataRow
              icon={<AgentAvatar emoji={a.emoji ?? "🤖"} className="h-8 w-8 text-sm" />}
              title={a.name}
              meta={`${a.answers} ${a.answers === 1 ? "reply" : "replies"} · ${a.covered} stood on a passage`}
              trailing={<Chip tone={worthPointingAt ? "on" : "neutral"}>{share}% not covered</Chip>}
            />
          </li>
        );
      })}
    </ul>
  );
}
