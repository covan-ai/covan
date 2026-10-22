import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ActivityItem, type HomeAgent, type HomeOverview } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import { useShell } from "@/lib/shell";
import { useWorkspaceRole } from "@/lib/workspace-role";
import { chartDate, chartDay, tickLabel } from "@/lib/chart-scale";
import {
  activityLine,
  amountValue,
  amountWords,
  feedTime,
  firstName,
  greeting,
  homeDate,
  homeSentence,
  needsYouParts,
  spendNote,
  weekDelta,
  workingOnDetail,
} from "@/lib/home-sentence";
import { AgentMark } from "@/components/agent-mark";
import { AskBar } from "@/components/ask-bar";
import { Avatar } from "@/components/avatar";
import { BarChart } from "@/components/bar-chart";
import { CoverageNotice } from "@/components/coverage-notice";
import { DataTable, type Column } from "@/components/data-table";
import { ReadOnlyNotice } from "@/components/empty-page";
import { FirstSteps, GettingStarted } from "@/components/getting-started";
import { HBarList } from "@/components/hbar-list";
import { NewThreadButton } from "@/components/new-thread-button";
import { PageBody } from "@/components/page";
import { SectionLabel } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusDot, StatusWord } from "@/components/status-dot";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/app")({
  component: Home,
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
});

/** Home is read every 30 seconds while it is open: who is running moves. */
const HOME_POLL_MS = 30_000;
const WINDOW_DAYS = 7;

/**
 * Home (Main, A19, A24, A33): what needs you, what is running, what the week
 * cost and who did what — one read, `GET /home/overview`. A workspace with no
 * agents yet gets the welcome in its place (A24). Money and people are an
 * admin's: the chart, spend by agent and the team's bars come only when the
 * overview carries them.
 */
function Home() {
  const { agents, favorites, canWrite } = useAgentsStore();
  const { me, isAdmin } = useWorkspaceRole();
  const { new: openNew } = Route.useSearch();
  const navigate = useNavigate();
  const shell = useShell();

  const {
    data: overview,
    dataUpdatedAt,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["home", "overview"],
    queryFn: () => api.home.overview(),
    refetchInterval: HOME_POLL_MS,
  });

  // A pinned agent, else the first, until a pick is made. `agentId` holds a
  // pick and only a pick: an agent that is deleted leaves its id behind, and
  // `?? defaultAgent` recovers where a stored default would not.
  const defaultAgent = useMemo(
    () => agents.find((a) => favorites.includes(a.id)) ?? agents[0],
    [agents, favorites],
  );
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const selected = agents.find((a) => a.id === agentId) ?? defaultAgent;

  // The ⌘K "New agent" action deep-links here with ?new=true. The URL is a
  // request and this consumes it: it opens the shell's dialog, then takes the
  // request back out of the address bar so a reload does not reopen it.
  useEffect(() => {
    if (openNew) {
      shell.openCreateAgent();
      void navigate({ to: "/app", search: {}, replace: true });
    }
  }, [openNew, navigate, shell]);

  const now = new Date();
  const timeZone = overview?.user.timezone;
  const userName = overview?.user.name ?? me?.user.name;
  const empty = overview !== undefined && overview.agents.length === 0;

  return (
    <>
      <TopBar
        title="Home"
        actions={
          <>
            {isAdmin && (
              <Button asChild variant="secondary">
                <Link to="/team" search={{ invite: true }}>
                  Invite
                </Link>
              </Button>
            )}
            <NewThreadButton />
          </>
        }
        phoneActions={<NewThreadButton variant="ghost" iconOnly />}
      />
      <CoverageNotice
        workspaceId={me?.workspace.id ?? ""}
        enabled={me?.workspace.gapReportEnabled ?? false}
      />
      <PageBody width="home">
        {empty ? (
          <Welcome
            workspaceName={overview.workspace.name ?? me?.workspace.name ?? "your workspace"}
            userName={userName}
            canWrite={canWrite}
            memberCount={me?.members.length ?? 1}
          />
        ) : (
          <>
            <div className="mb-5">
              <h2 className="m-0 text-2xl leading-[1.2] font-semibold tracking-[-0.02em]">
                {greeting(now, userName, timeZone)}
              </h2>
              <p className="mt-1.5 text-lead text-muted-foreground">
                {overview
                  ? homeSentence({
                      now,
                      timeZone,
                      needsYou: overview.needsYou.total,
                      running: overview.agents
                        .filter((a) => a.status === "running")
                        .map((a) => ({ agent: a.name, title: a.workingOn?.title ?? null })),
                      spend: overview.spend
                        ? {
                            amount: overview.spend.window,
                            unit: overview.spend.unit,
                            days: WINDOW_DAYS,
                          }
                        : null,
                    })
                  : `${homeDate(now, timeZone)}.`}
              </p>
            </div>
            {canWrite ? (
              selected && <AskBar agents={agents} selected={selected} onSelect={setAgentId} />
            ) : (
              <ReadOnlyNotice
                workspaceName={overview?.workspace.name ?? me?.workspace.name ?? "this workspace"}
                viewerName={userName}
              />
            )}
            <GettingStarted className="mt-7" />
            {isError && !overview && (
              <p className="mt-7 text-sm text-muted-foreground">
                Couldn&rsquo;t load the overview.{" "}
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Try again
                </button>
              </p>
            )}
            {overview && <Overview overview={overview} myId={me?.user.id} now={dataUpdatedAt} />}
          </>
        )}
      </PageBody>
    </>
  );
}

/** A workspace with no agents yet (A24). */
function Welcome({
  workspaceName,
  userName,
  canWrite,
  memberCount,
}: {
  workspaceName: string;
  userName: string | null | undefined;
  canWrite: boolean;
  memberCount: number;
}) {
  const shell = useShell();
  return (
    <div className="max-w-[760px]">
      <h2 className="m-0 text-2xl leading-[1.2] font-semibold tracking-[-0.02em]">
        Welcome to {workspaceName}, {firstName(userName)}.
      </h2>
      {canWrite ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing is running yet. An agent takes a name, a face and a job; the first one takes
            about a minute.
          </p>
          <div className="mt-4 mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border px-3.5 py-3">
            <div aria-hidden className="flex gap-1.5">
              {(["headset", "owl", "bear", "blob"] as const).map((mark) => (
                <AgentMark key={mark} agent={{ name: mark, avatar: mark }} size={40} />
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Create your first agent</div>
              <div className="text-meta text-muted-foreground">
                Support, Research, Finance, or anything you name.
              </div>
            </div>
            <Button onClick={shell.openCreateAgent}>Create agent</Button>
          </div>
          <FirstSteps memberCount={memberCount} />
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is shared with you yet. Ask an admin or a member to share an agent with you.
        </p>
      )}
    </div>
  );
}

/** Everything under the ask bar, once the overview is in. */
function Overview({
  overview,
  myId,
  now,
}: {
  overview: HomeOverview;
  myId: string | undefined;
  /** When the overview was read: every "12 min ago" on the page counts from it. */
  now: number;
}) {
  const { needsYou, threads, routineRuns, spend, credits, team, activity } = overview;
  const names = new Map(overview.agents.map((a) => [a.agentId, a]));
  const unit = spend?.unit ?? "credits";

  const stats: ReactNode[] = [
    <StatCard
      key="needs"
      to="/inbox"
      label="Needs you"
      value={needsYou.total}
      detail={
        needsYou.total > 0 ? (
          <>
            <StatusDot state="waiting" />
            {needsYouParts(needsYou)}
          </>
        ) : (
          "Nothing waiting"
        )
      }
    />,
    <StatCard
      key="threads"
      label="Threads, last 7 days"
      value={threads.window.toLocaleString("en-US")}
      detail={weekDelta(threads.window, threads.previous)}
    />,
  ];
  if (spend) {
    stats.push(
      <StatCard
        key="spend"
        label={unit === "usd" ? "Spent, last 7 days" : "Credits spent, last 7 days"}
        value={amountValue(spend.window, unit)}
        detail={
          credits
            ? `${credits.balance.toLocaleString("en-US")} left`
            : "Estimated from model prices"
        }
        meter={
          credits && spend.window + credits.balance > 0
            ? spend.window / (spend.window + credits.balance)
            : undefined
        }
      />,
    );
  } else if (credits) {
    stats.push(
      <StatCard
        key="credits"
        label="Credits left"
        value={credits.balance.toLocaleString("en-US")}
        detail="For everyone in the workspace"
      />,
    );
  }
  stats.push(
    <StatCard
      key="routines"
      label="Routine runs, last 7 days"
      value={routineRuns.total.toLocaleString("en-US")}
      detail={
        routineRuns.total > 0
          ? `${routineRuns.done} done, ${routineRuns.failed} failed`
          : "None this week"
      }
    />,
  );

  return (
    <>
      <div
        className={cn(
          "mt-7 grid grid-cols-2 gap-4",
          stats.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
        )}
      >
        {stats}
      </div>

      {spend && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel
            className="lg:col-span-2"
            title={unit === "usd" ? "Spent, last 14 days" : "Credits spent, last 14 days"}
            sub="Per day, all agents. Hover a day for the split."
            action={
              <Button asChild variant="ghost" size="sm" className="text-meta">
                <Link to="/settings/usage">Usage</Link>
              </Button>
            }
          >
            <BarChart
              label={unit === "usd" ? "Spent per day" : "Credits spent per day"}
              tick={(v) => tickLabel(v, unit)}
              bars={spend.daily.map((d, i) => ({
                key: d.day,
                value: d.total,
                previous: i < spend.daily.length - WINDOW_DAYS,
                title: `${chartDay(d.day)} · ${amountWords(d.total, unit)}`,
                detail: Object.entries(d.byAgent)
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(
                    ([id, v]) =>
                      `${names.get(id)?.name ?? "A deleted agent"} ${amountValue(v, unit)}`,
                  )
                  .join(" · "),
              }))}
              axis={
                spend.daily.length > WINDOW_DAYS
                  ? [
                      chartDate(spend.daily[0]!.day),
                      chartDate(spend.daily[spend.daily.length - WINDOW_DAYS]!.day),
                      "Today",
                    ]
                  : ["Today"]
              }
            />
          </Panel>
          <Panel title="Spend by agent" sub={`Last 7 days, ${amountWords(spend.window, unit)}`}>
            {spend.byAgent.length > 0 ? (
              <HBarList
                className="mt-4"
                label="Spend by agent, last 7 days"
                rows={spend.byAgent.slice(0, 5).map((r) => {
                  const agent = names.get(r.agentId);
                  return {
                    key: r.agentId,
                    lead: <AgentMark agent={agent ?? { name: "?" }} size={24} />,
                    label: agent?.name ?? "A deleted agent",
                    value: r.amount,
                    display: amountValue(r.amount, unit),
                  };
                })}
              />
            ) : (
              <p className="mt-4 text-meta text-muted-foreground">Nothing spent this week.</p>
            )}
            {(() => {
              const note = spendNote(spend.daily, (id) => names.get(id)?.name, unit, WINDOW_DAYS);
              return note ? <p className="mt-3.5 text-meta text-muted-foreground">{note}</p> : null;
            })()}
          </Panel>
        </div>
      )}

      <section className="mt-7">
        <SectionLabel as="h2">Right now</SectionLabel>
        <div className="overflow-x-auto">
          <RightNow
            agents={overview.agents}
            showSpend={spend !== undefined}
            unit={unit}
            now={now}
          />
        </div>
      </section>

      <div className={cn("mt-7 grid gap-10", team && "lg:grid-cols-2")}>
        {team && (
          <section>
            <SectionLabel
              as="h2"
              action={
                <Link to="/team" className="hover:text-foreground">
                  Team
                </Link>
              }
            >
              Team, last 7 days
            </SectionLabel>
            {team.length > 0 ? (
              <HBarList
                label="Threads started by each member, last 7 days"
                tone="prev"
                nameWidth={140}
                valueWidth={32}
                rows={[...team]
                  .sort((a, b) => b.threads - a.threads)
                  .slice(0, 6)
                  .map((m) => ({
                    key: m.userId,
                    lead: <Avatar name={m.name} url={m.avatarUrl} size={20} />,
                    label: m.userId === myId ? "You" : firstName(m.name),
                    value: m.threads,
                  }))}
              />
            ) : (
              <p className="text-meta text-muted-foreground">
                Nobody has started a thread this week.
              </p>
            )}
          </section>
        )}
        <section>
          <SectionLabel as="h2">Recent activity</SectionLabel>
          {activity.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {activity.slice(0, 5).map((item) => (
                <ActivityRow key={item.id} item={item} myId={myId} now={now} />
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground">
              Shared threads, finished routines and new files show up here.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

/** A bordered box with a 14/600 title, a muted line, and a link on the right. */
function Panel({
  title,
  sub,
  action,
  children,
  className,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border px-[18px] py-4", className)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-semibold">{title}</h3>
          {sub && <div className="mt-0.5 text-meta text-muted-foreground">{sub}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const STATUS: Record<HomeAgent["status"], { dot: "running" | "waiting" | "idle"; word: string }> = {
  running: { dot: "running", word: "Running" },
  needs_you: { dot: "waiting", word: "Needs you" },
  idle: { dot: "idle", word: "Idle" },
};

/** Right now (Main): each agent, what it is doing, and its week. */
function RightNow({
  agents,
  showSpend,
  unit,
  now,
}: {
  agents: HomeAgent[];
  showSpend: boolean;
  unit: "credits" | "usd";
  now: number;
}) {
  const columns: Column<HomeAgent>[] = [
    {
      key: "agent",
      header: "Agent",
      className: "w-[170px]",
      cell: (a) => (
        <Link
          to="/agents/$agentId/threads"
          params={{ agentId: a.agentId }}
          className="flex items-center gap-2.5 font-medium hover:underline"
        >
          <AgentMark agent={a} size={24} />
          <span className="truncate">{a.name}</span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      className: "w-[130px]",
      cell: (a) => <StatusWord state={STATUS[a.status].dot}>{STATUS[a.status].word}</StatusWord>,
    },
    {
      key: "working",
      header: "Working on",
      cell: (a) => {
        const w = a.workingOn;
        if (!w) return <span className="text-muted-foreground">Nothing yet</span>;
        const title = w.sessionId ? (
          <Link
            to="/agents/$agentId/chat"
            params={{ agentId: a.agentId }}
            search={{ s: w.sessionId }}
            className="hover:underline"
          >
            {w.title}
          </Link>
        ) : (
          <span>{w.title}</span>
        );
        return (
          <span className="block max-w-[520px] truncate">
            {w.kind === "last" && <span className="text-muted-foreground">Last: </span>}
            {title}
            <span className="text-muted-foreground"> · {workingOnDetail(w, now)}</span>
          </span>
        );
      },
    },
    {
      key: "threads",
      header: "Threads, 7 d",
      num: true,
      cell: (a) => a.threadsWindow.toLocaleString("en-US"),
    },
  ];
  if (showSpend) {
    columns.push({
      key: "spend",
      header: unit === "usd" ? "Spent, 7 d" : "Credits, 7 d",
      num: true,
      cell: (a) => amountValue(a.spendWindow ?? 0, unit),
    });
  }
  return (
    <DataTable
      label="What each agent is doing"
      columns={columns}
      rows={agents}
      rowKey={(a) => a.agentId}
    />
  );
}

/** One line of Recent activity: who, what, and when. */
function ActivityRow({
  item,
  myId,
  now,
}: {
  item: ActivityItem;
  myId: string | undefined;
  now: number;
}) {
  const line = activityLine(item);
  const agentId = typeof item.detail?.agent_id === "string" ? item.detail.agent_id : null;
  const sessionId =
    item.subjectType === "session"
      ? item.subjectId
      : typeof item.detail?.session_id === "string"
        ? item.detail.session_id
        : null;
  const who =
    item.actor.kind === "person" && item.actor.id === myId
      ? "You"
      : item.actor.kind === "person"
        ? firstName(item.actor.name)
        : item.actor.name;

  const subject =
    agentId && sessionId ? (
      <Link
        to="/agents/$agentId/chat"
        params={{ agentId }}
        search={{ s: sessionId }}
        className="hover:underline"
      >
        {line.subject}
      </Link>
    ) : item.subjectType === "routine" && item.subjectId ? (
      <Link
        to="/routines/$routineId"
        params={{ routineId: item.subjectId }}
        className="hover:underline"
      >
        {line.subject}
      </Link>
    ) : item.subjectType === "document" ? (
      <Link to="/knowledge" className="hover:underline">
        {line.subject}
      </Link>
    ) : (
      line.subject
    );

  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-hairline px-1 text-sm">
      {item.actor.kind === "agent" ? (
        <AgentMark agent={{ name: item.actor.name, avatar: item.actor.avatar }} size={24} />
      ) : (
        <Avatar name={item.actor.name} url={item.actor.avatar} size={24} />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{who}</span>
        {line.before && ` ${line.before}`} {subject}
        {line.after && ` ${line.after}`}
      </span>
      <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
        {feedTime(item.createdAt, now)}
      </span>
    </li>
  );
}
