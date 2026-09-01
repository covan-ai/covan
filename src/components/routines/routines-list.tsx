import { Link } from "@tanstack/react-router";
import { SectionCard, EmptyState, Chip } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
import { RoutineStatus } from "@/components/routines/routine-status";
import { cronToProse } from "@/lib/cron-to-prose";
import { formatRelative } from "@/lib/relative-time";
import type { Routine } from "@/lib/routines-api";

export function RoutinesList({
  agentId,
  currentUserId,
  memberNames,
  routines,
  action,
}: {
  agentId: string;
  currentUserId: string | null;
  /** userId -> display name, resolved from api.me().members. */
  memberNames: Record<string, string>;
  routines: Routine[];
  action: React.ReactNode;
}) {
  // GET /routines returns everything the caller can see, not just this agent's,
  // so the tab filters here. At tens of routines per user this is cheaper than
  // teaching the API a query parameter.
  const forAgent = routines.filter((r) => r.agentId === agentId);
  const mine = forAgent.filter((r) => r.userId === currentUserId);
  const team = forAgent.filter((r) => r.userId !== currentUserId);

  if (forAgent.length === 0) {
    return (
      <EmptyState
        className="mt-8"
        title="No routines yet"
        description="A routine lets this agent watch a feed or a page on a schedule and send you what changed."
        action={action}
      />
    );
  }

  return (
    <>
      <Group
        title="Team routines"
        items={team}
        agentId={agentId}
        currentUserId={currentUserId}
        memberNames={memberNames}
      />
      <Group
        title="My routines"
        items={mine}
        agentId={agentId}
        currentUserId={currentUserId}
        memberNames={memberNames}
      />
    </>
  );
}

/**
 * One titled group of routines, or nothing when the group is empty.
 *
 * Defined here rather than inside `RoutinesList`, which is where it used to
 * live. A component declared in a render body is a new component *type* on
 * every render, so React cannot match it against the previous tree: it unmounts
 * the old one and mounts a fresh one, losing DOM state and re-running effects
 * for the whole subtree each time the parent renders. It looked like a closure
 * and behaved like a remount. `eslint-plugin-react-hooks` 7 reports it as
 * `react-hooks/static-components`; before 7 nothing did.
 *
 * The three values it used to close over are props now, which is the whole cost.
 */
function Group({
  title,
  items,
  agentId,
  currentUserId,
  memberNames,
}: {
  title: string;
  items: Routine[];
  agentId: string;
  currentUserId: string | null;
  memberNames: Record<string, string>;
}) {
  return items.length === 0 ? null : (
    <section className="mt-8">
      <SectionHeading title={title} />
      <SectionCard padded={false} className="mt-3 overflow-hidden">
        <ul className="divide-y divide-hairline">
          {items.map((r) => (
            <li key={r.id}>
              <Link
                to="/agents/$agentId/routines/$routineId"
                params={{ agentId, routineId: r.id }}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors duration-200 hover:bg-surface-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-dm text-[17px] font-medium leading-tight">
                      {r.name}
                    </span>
                    {r.visibility === "shared" && <Chip tone="on">Shared</Chip>}
                  </div>
                  {/* The "·" separators are their own aria-hidden nodes so each
                        fact stays a readable unit rather than one run-on string. */}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">{cronToProse(r.scheduleCron)}</span>
                    {r.userId !== currentUserId && (
                      <>
                        <span aria-hidden>·</span>
                        <span>by {memberNames[r.userId] ?? "a teammate"}</span>
                      </>
                    )}
                    {r.status === "active" && r.nextRunAt !== null && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">next {formatRelative(r.nextRunAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <RoutineStatus routine={r} className="max-w-[45%] shrink-0 justify-end" />
              </Link>
            </li>
          ))}
        </ul>
      </SectionCard>
    </section>
  );
}
