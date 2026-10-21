import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
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
import { Chip } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * The setup list in the sidebar: five things a new workspace still has to do,
 * each with a "Try" that goes to the place and points at the control.
 *
 * It took over from the card under the home composer, so there is one list
 * and it is reachable from everywhere. The words come from
 * `onboarding-config.ts`; the ticks come from `first-week.ts`, which reads
 * them off state the app already holds — a step is never shown done on a
 * guess. Hidden from a viewer (the policies refuse them most of it), from a
 * workspace with no agents, once everything is done, and once somebody has
 * put it down.
 */
export function SetupList({
  agentId,
  onNavigate,
}: {
  /** The agent whose pages the chat and routine steps go to, when inside one. */
  agentId?: string;
  /** Closes the phone drawer, as every row in the panel does. */
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { agents, sessions, canWrite } = useAgentsStore();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const workspaceId = me?.workspace.id;
  const { dismissed, dismiss } = useChecklistDismissed(workspaceId);
  const { open, setOpen } = useSetupOpen(workspaceId);
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

  const targetAgentId = agentId ?? onboarding?.agentId ?? agents[0]?.id;

  const tryStep = (row: (typeof rows)[number], e: MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    let target: CoachTarget = row.cfg.coach(setupCtx);
    // The Connect card under the opening line is the better place to point,
    // while it is on screen.
    if (row.cfg.key === "connect" && document.querySelector('[data-coach="kickoff-card"]')) {
      target = {
        ...target,
        id: "kickoff-card",
        route: "chat",
        title: setupCtx.toolName ? `Connect ${setupCtx.toolName}` : target.title,
      };
    }
    onNavigate();
    goTo(target.route);
    openCoachMark(target, { returnFocusTo: anchor });
  };

  const goTo = (route: CoachTarget["route"]) => {
    switch (route) {
      case "chat": {
        if (!targetAgentId) return;
        const to = `/agents/${targetAgentId}/chat`;
        if (pathname === to) return;
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
        if (pathname !== "/integrations") void navigate({ to: "/integrations" });
        return;
      case "members":
        if (pathname !== "/settings/members") void navigate({ to: "/settings/members" });
        return;
      case "routines": {
        if (!targetAgentId) return;
        const to = `/agents/${targetAgentId}/routines`;
        if (pathname === to) return;
        void navigate({ to: "/agents/$agentId/routines", params: { agentId: targetAgentId } });
        return;
      }
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-2 pt-3">
      <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground transition-colors duration-200 hover:text-foreground">
        <span>
          Setup · {rows.length - remaining} of {rows.length}
        </span>
        <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="motion-reduce:animate-none">
        <ul className="space-y-0.5 pb-1 pt-1">
          {rows.map((row) => (
            <li
              key={row.cfg.key}
              className="flex min-h-8 items-start gap-2.5 rounded-md px-3 py-1.5 text-sm"
            >
              {row.done ? (
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
              ) : (
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-dashed border-border" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span
                  className={cn(
                    "leading-tight",
                    row.done ? "text-muted-foreground line-through" : "font-medium",
                  )}
                  title={row.cfg.hint(setupCtx)}
                >
                  {row.cfg.label(setupCtx)}
                </span>
                {/* A promise without a number: the hosted build decides the
                    amount and writes it to the ledger as "Credits added". */}
                {row.cfg.rewarded && !row.done && hosted === true ? (
                  <Chip tone="neutral" className="self-start">
                    Earns credits
                  </Chip>
                ) : null}
              </span>
              {!row.done ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mt-1 h-7 shrink-0 px-2 text-xs text-muted-foreground"
                  onClick={(e) => tryStep(row, e)}
                  aria-label={`${CTA.try}: ${row.cfg.label(setupCtx)}`}
                >
                  {CTA.try}
                </Button>
              ) : null}
            </li>
          ))}
          <li className="px-3 pt-1">
            <button
              type="button"
              onClick={dismiss}
              className="text-xs text-micro-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Hide this list
            </button>
          </li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/*
 * Open or folded, per workspace, in localStorage — read through
 * `useSyncExternalStore` the way `useChecklistDismissed` reads its flag, and
 * for the same reasons. Open by default: the list is for the first days, and
 * folding it is the person's call.
 */
const openListeners = new Set<() => void>();
const openHere = new Map<string, boolean>();

function subscribeOpen(onStoreChange: () => void) {
  openListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    openListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function openKey(workspaceId: string | undefined) {
  return workspaceId ? `covan:setup-open:${workspaceId}` : null;
}

function useSetupOpen(workspaceId: string | undefined) {
  const key = openKey(workspaceId);
  const open = useSyncExternalStore(
    subscribeOpen,
    () => {
      if (!key) return true;
      const here = openHere.get(key);
      if (here !== undefined) return here;
      try {
        return window.localStorage.getItem(key) !== "0";
      } catch {
        return true;
      }
    },
    () => true,
  );
  const setOpen = (next: boolean) => {
    if (!key) return;
    openHere.set(key, next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* this tab remembers; see above */
    }
    for (const listener of openListeners) listener();
  };
  return { open, setOpen };
}
