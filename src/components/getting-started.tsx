import { useMemo, type MouseEvent, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import { useIsHosted } from "@/lib/credits";
import { connectedSlugs } from "@/lib/connected-apps";
import { connectionsKey, slackKey, toolConnectionsKey } from "@/hooks/use-connections";
import { firstWeekSteps, useChecklistDismissed } from "@/lib/first-week";
import { openCoachMark } from "@/lib/coach-marks";
import {
  CTA,
  SETUP,
  firstConnectableTool,
  type CoachTarget,
  type SetupContext,
} from "@/lib/onboarding-config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The reward the hosted build pays for a workspace's first document. */
const REWARD = "earns 200 credits";

function CheckRow({
  done,
  children,
  note,
  action,
}: {
  done: boolean;
  children: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex min-h-8 items-center gap-2.5 text-sm">
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-[4px] border",
          done ? "border-foreground bg-foreground text-background" : "border-dot-done",
        )}
      >
        {done && <Check className="size-3" strokeWidth={2.5} />}
      </span>
      <span className={cn("min-w-0", done && "text-muted-foreground line-through")}>
        {children}
        <span className="sr-only">{done ? " (done)" : ""}</span>
      </span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
      {action && <span className="ml-2">{action}</span>}
    </li>
  );
}

/**
 * A workspace with no agents yet (A24): the four first things, the first
 * one already done. The words are the board's; only the ticks are read.
 */
export function FirstSteps({ memberCount }: { memberCount: number }) {
  const hosted = useIsHosted();
  return (
    <section aria-labelledby="first-steps" className="w-full">
      <h3
        id="first-steps"
        className="mb-1 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase"
      >
        Getting started
      </h3>
      <ul className="m-0 list-none p-0">
        <CheckRow done>Create the workspace</CheckRow>
        <CheckRow done={false}>Create an agent</CheckRow>
        <CheckRow done={false} note={hosted === true ? REWARD : undefined}>
          Add the first documents to Knowledge
        </CheckRow>
        <CheckRow done={memberCount > 1}>Invite the team</CheckRow>
      </ul>
    </section>
  );
}

/**
 * What a new workspace still has to do once it has an agent, on Home under
 * the ask bar: each step with a "Try" that goes to the place and points at
 * the control.
 *
 * The words come from `onboarding-config.ts`; the ticks come from
 * `first-week.ts`, which reads them off state the app already holds — a step
 * is never shown done on a guess. Hidden from a viewer (the policies refuse
 * them most of it), from a workspace with no agents (`FirstSteps` is there),
 * once everything is done, and once somebody has put it down.
 */
export function GettingStarted({ className }: { className?: string }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { agents, sessions, canWrite } = useAgentsStore();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const workspaceId = me?.workspace.id;
  const { dismissed, dismiss } = useChecklistDismissed(workspaceId);
  const hosted = useIsHosted();

  const visible = canWrite && agents.length > 0 && !dismissed;

  // Asked for only while they could still change the answer, so a settled
  // workspace stops paying for them on every visit.
  const { data: routines = [] } = useQuery({
    queryKey: ["routines"],
    queryFn: () => api.routines.list(),
    enabled: visible,
  });
  const { data: tools } = useQuery({
    queryKey: toolConnectionsKey,
    queryFn: () => api.toolConnections.list(),
    enabled: visible,
  });
  const { data: sources } = useQuery({
    queryKey: connectionsKey,
    queryFn: () => api.connections.list(),
    enabled: visible,
  });
  const { data: slack } = useQuery({
    queryKey: slackKey,
    queryFn: () => api.slack.get(),
    enabled: visible,
  });

  const connected = useMemo(
    () =>
      connectedSlugs(
        tools?.connections ?? [],
        sources?.connections ?? [],
        Boolean(slack?.installation),
      ),
    [tools, sources, slack],
  );

  const onboarding = me?.onboarding;
  const setupCtx: SetupContext = {
    toolName: firstConnectableTool(onboarding?.answers.tools, connected)?.name ?? null,
    mode: onboarding?.answers.mode ?? null,
  };

  const done = firstWeekSteps({
    agents,
    sessions,
    memberCount: me?.members?.length ?? 1,
    routineCount: routines.length,
    connectedCount: connected.size,
  });
  const rows = SETUP.map((cfg) => ({
    cfg,
    done: done.find((s) => s.key === cfg.key)?.done ?? false,
  }));
  const remaining = rows.filter((r) => !r.done).length;

  if (!visible || remaining === 0) return null;

  const targetAgentId = onboarding?.agentId ?? agents[0]?.id;

  const goTo = (route: CoachTarget["route"]) => {
    switch (route) {
      case "chat": {
        if (!targetAgentId) return;
        if (pathname === `/agents/${targetAgentId}/chat`) return;
        void navigate({
          to: "/agents/$agentId/chat",
          params: { agentId: targetAgentId },
          search: {
            s:
              onboarding?.agentId === targetAgentId
                ? (onboarding?.sessionId ?? undefined)
                : undefined,
          },
        });
        return;
      }
      case "integrations":
        if (pathname !== "/settings/integrations") void navigate({ to: "/settings/integrations" });
        return;
      case "members":
        if (pathname !== "/team") void navigate({ to: "/team" });
        return;
      case "routines": {
        if (!targetAgentId) return;
        if (pathname === `/agents/${targetAgentId}/routines`) return;
        void navigate({ to: "/agents/$agentId/routines", params: { agentId: targetAgentId } });
        return;
      }
    }
  };

  const tryStep = (row: (typeof rows)[number], e: MouseEvent<HTMLButtonElement>) => {
    const target = row.cfg.coach(setupCtx);
    goTo(target.route);
    openCoachMark(target, {
      returnFocusTo: e.currentTarget,
      position: { step: rows.indexOf(row) + 1, total: rows.length },
      onSkip: dismiss,
    });
  };

  return (
    <section
      aria-labelledby="getting-started"
      className={cn("rounded-xl border border-border px-[18px] py-3", className)}
    >
      <div className="flex h-7 items-center justify-between">
        <h3
          id="getting-started"
          className="m-0 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase"
        >
          Getting started · {rows.length - remaining} of {rows.length}
        </h3>
        <button
          type="button"
          onClick={dismiss}
          className="text-meta font-medium text-muted-foreground hover:text-foreground"
        >
          Hide this list
        </button>
      </div>
      <ul className="m-0 grid list-none gap-x-8 p-0 lg:grid-cols-2">
        {rows.map((row) => (
          <CheckRow
            key={row.cfg.key}
            done={row.done}
            note={row.cfg.rewarded && !row.done && hosted === true ? REWARD : undefined}
            action={
              row.done ? undefined : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={(e) => tryStep(row, e)}
                  aria-label={`${CTA.try}: ${row.cfg.label(setupCtx)}`}
                >
                  {CTA.try}
                </Button>
              )
            }
          >
            {row.cfg.label(setupCtx)}
          </CheckRow>
        ))}
      </ul>
    </section>
  );
}
