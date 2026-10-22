import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { asAvatarMark, toEpochMs, type AvatarMark } from "../lib/dto";
import { estimateCostUsd } from "../lib/pricing";
import { quoteOf } from "../lib/entitlements";
import { mapInboxRow, touchPresence, type InboxItemDTO } from "./inbox";
import { deferred } from "../lib/defer";

/**
 * Home (the Main board, A19, A24, A33): one read for the whole screen.
 *
 * Every figure comes from a function that already decides who may see it
 * (0122, 0123, 0124). This file adds them up and decides what each agent is
 * "working on" from the threads the caller can see — never from somebody
 * else's private one, which is why a running agent the caller cannot see
 * into reads as idle rather than as a title they may not read.
 *
 * Money and people are an admin's (0032): the spend chart, spend by agent and
 * the team's threads per member are left out for everybody else, and the
 * screen leaves their sections out with them. Spend is priced here from the
 * models and tokens each reply recorded, as `GET /usage/workspace` prices its
 * months, and quoted in credits where the hosted build can say what a dollar
 * is worth.
 */
const home = new Hono<AppEnv>();

const query = z.object({ days: z.coerce.number().int().min(1).max(30).optional() });

/** How long a claimed routine counts as running before it is presumed dead. */
const ROUTINE_RUNNING_FOR_MS = 30 * 60_000;
const SPEND_DAYS = 14;

export type HomeAgentStatus = "running" | "needs_you" | "idle";

export type HomeAgentDTO = {
  agentId: string;
  name: string;
  avatar: AvatarMark | null;
  status: HomeAgentStatus;
  workingOn: {
    sessionId: string | null;
    title: string;
    kind: "running" | "question" | "approval" | "login" | "routine_failed" | "last";
    stepsDone?: number;
    note?: string | null;
    since: number;
  } | null;
  threadsWindow: number;
  spendWindow?: number;
};

export type ActivityDTO = {
  id: string;
  action: string;
  actor: { kind: "agent" | "person"; id: string | null; name: string; avatar?: string | null };
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string;
  /** How many events this row stands for: three files added at once is one row. */
  count: number;
  detail: Record<string, unknown> | null;
  createdAt: number;
};

type ActivityRow = {
  id: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

/**
 * The feed as rows a person reads: an agent is the actor of its routine's
 * runs, a person of everything else, and files one person added to one folder
 * within an hour are one row ("Elif added 3 files to Knowledge / Contracts").
 */
export function shapeActivity(rows: ActivityRow[]): ActivityDTO[] {
  const out: ActivityDTO[] = [];
  for (const r of rows) {
    const at = toEpochMs(r.created_at);
    const previous = out[out.length - 1];
    if (
      r.action === "document.added" &&
      previous?.action === "document.added" &&
      previous.actor.id === r.actor_id &&
      previous.detail?.bundle_id === r.detail?.bundle_id &&
      previous.createdAt - at < 60 * 60_000
    ) {
      previous.count += 1;
      continue;
    }
    const byAgent = r.action.startsWith("routine.");
    out.push({
      id: r.id,
      action: r.action,
      actor: byAgent
        ? {
            kind: "agent",
            id: r.agent_id,
            name: r.agent_name ?? "An agent",
            avatar: asAvatarMark(r.agent_avatar),
          }
        : {
            kind: "person",
            id: r.actor_id,
            name: r.actor_name ?? "Somebody",
            avatar: r.actor_avatar,
          },
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      subjectLabel: r.subject_label,
      count: 1,
      detail: r.detail,
      createdAt: at,
    });
  }
  return out;
}

type SpendRow = {
  day: string;
  agent_id: string;
  model: string | null;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  cached_tokens: number | string;
  cache_write_tokens: number | string;
};

/** `YYYY-MM-DD` for the `count` days ending today, oldest first, in UTC. */
export function lastDays(count: number, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Spend per day and per agent, priced and (where the deployment can) quoted
 * in credits. Rounded at the end, never per row, so fourteen days of small
 * replies do not round to nothing.
 */
export function shapeSpend(
  rows: SpendRow[],
  quote: ((usd: number) => number) | null,
  windowDays: number,
  now: Date = new Date(),
): {
  unit: "credits" | "usd";
  daily: Array<{ day: string; total: number; byAgent: Record<string, number> }>;
  byAgent: Array<{ agentId: string; amount: number }>;
  window: number;
  previousWindow: number;
} {
  const days = lastDays(SPEND_DAYS, now);
  const daily = new Map(days.map((d) => [d, new Map<string, number>()]));
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const bucket = daily.get(day);
    if (!bucket) continue;
    const usd = estimateCostUsd(
      r.model ?? "",
      Number(r.prompt_tokens) || 0,
      Number(r.completion_tokens) || 0,
      Number(r.cached_tokens) || 0,
      Number(r.cache_write_tokens) || 0,
    );
    bucket.set(r.agent_id, (bucket.get(r.agent_id) ?? 0) + usd);
  }
  const unit = quote ? "credits" : "usd";
  const amount = (usd: number) => (quote ? Math.round(quote(usd)) : Math.round(usd * 100) / 100);

  const windowStart = days.length - windowDays;
  const perAgent = new Map<string, number>();
  let windowUsd = 0;
  let previousUsd = 0;
  const shaped = days.map((day, i) => {
    const bucket = daily.get(day)!;
    let total = 0;
    const byAgent: Record<string, number> = {};
    for (const [agentId, usd] of bucket) {
      total += usd;
      byAgent[agentId] = amount(usd);
      if (i >= windowStart) perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + usd);
    }
    if (i >= windowStart) windowUsd += total;
    else if (i >= windowStart - windowDays) previousUsd += total;
    return { day, total: amount(total), byAgent };
  });

  return {
    unit,
    daily: shaped,
    byAgent: [...perAgent.entries()]
      .map(([agentId, usd]) => ({ agentId, amount: amount(usd) }))
      .sort((a, b) => b.amount - a.amount),
    window: amount(windowUsd),
    previousWindow: amount(previousUsd),
  };
}

type AgentRow = { id: string; name: string; avatar: string | null; created_at: string };
type RoutineRunning = { agent_id: string; name: string; claimed_at: string | null };

/**
 * What each agent is doing, from what the caller can see: a running turn
 * first, then something waiting on them, then a routine mid-run, then the
 * last thing it did.
 */
export function agentsNow(
  agents: AgentRow[],
  items: InboxItemDTO[],
  waiting: InboxItemDTO[],
  routines: RoutineRunning[],
  threads: Map<string, number>,
  spend: Map<string, number> | null,
  now: number = Date.now(),
): HomeAgentDTO[] {
  return agents.map((a) => {
    const mine = items.filter((i) => i.agentId === a.id);
    const running = mine.find((i) => i.running);
    const asking = waiting.find((i) => i.agentId === a.id);
    const routine = routines.find(
      (r) =>
        r.agent_id === a.id &&
        r.claimed_at &&
        now - Date.parse(r.claimed_at) < ROUTINE_RUNNING_FOR_MS,
    );
    const last = mine[0];

    let status: HomeAgentStatus = "idle";
    let workingOn: HomeAgentDTO["workingOn"] = null;
    if (running?.running) {
      status = "running";
      workingOn = {
        sessionId: running.sessionId,
        title: running.title ?? "Untitled thread",
        kind: "running",
        stepsDone: running.running.stepsDone,
        note: running.running.note,
        since: running.running.since,
      };
    } else if (asking?.needsYou) {
      status = "needs_you";
      workingOn = {
        sessionId: asking.sessionId,
        title: asking.title ?? "Untitled thread",
        kind: asking.needsYou.kind,
        since: asking.needsYou.since,
      };
    } else if (routine) {
      status = "running";
      workingOn = {
        sessionId: null,
        title: routine.name,
        kind: "running",
        since: Date.parse(routine.claimed_at!),
      };
    } else if (last) {
      workingOn = {
        sessionId: last.sessionId,
        title: last.title ?? "Untitled thread",
        kind: "last",
        since: last.lastActivityAt,
      };
    }

    return {
      agentId: a.id,
      name: a.name,
      avatar: asAvatarMark(a.avatar),
      status,
      workingOn,
      threadsWindow: threads.get(a.id) ?? 0,
      ...(spend ? { spendWindow: spend.get(a.id) ?? 0 } : {}),
    };
  });
}

// GET /home/overview
home.get("/home/overview", async (c) => {
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const days = parsed.data.days ?? 7;

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const db = c.get("db");
  const user = c.get("user");
  // Home and the Inbox are what "last active" means (0128): stamped after the
  // answer, never in front of it.
  deferred(c, touchPresence(db, workspaceId));
  const [
    profile,
    workspace,
    membership,
    counts,
    agentThreads,
    recent,
    waiting,
    agents,
    routines,
    activity,
    spend,
    team,
    snapshot,
  ] = await Promise.all([
    db.from("profiles").select("name, timezone").eq("id", user.id).maybeSingle(),
    db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
    db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle(),
    db.rpc("home_counts", { p_workspace_id: workspaceId, p_days: days }),
    db.rpc("home_agent_threads", { p_workspace_id: workspaceId, p_days: days }),
    db.rpc("inbox_rows", {
      p_workspace_id: workspaceId,
      p_filter: "all",
      p_agent_id: null,
      p_before: null,
      p_limit: 200,
      p_session_ids: null,
    }),
    db.rpc("inbox_rows", {
      p_workspace_id: workspaceId,
      p_filter: "needs_you",
      p_agent_id: null,
      p_before: null,
      p_limit: 200,
      p_session_ids: null,
    }),
    db
      .from("agents")
      .select("id, name, avatar, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at"),
    db
      .from("routines")
      .select("agent_id, name, claimed_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .not("claimed_at", "is", null),
    db.rpc("workspace_activity", { p_workspace_id: workspaceId, p_limit: 30 }),
    db.rpc("workspace_spend_daily", { p_workspace_id: workspaceId, p_days: SPEND_DAYS }),
    db.rpc("workspace_threads_by_member", { p_workspace_id: workspaceId, p_days: days }),
    c
      .get("entitlements")
      .snapshot(workspaceId)
      .catch(() => ({ metered: false as const })),
  ]);

  const failed = [counts, agentThreads, recent, waiting, agents].find((r) => r.error);
  if (failed?.error) {
    console.error("home overview failed", failed.error);
    return c.json({ error: "failed to load home" }, 500);
  }

  const isAdmin = membership.data?.role === "admin";
  const items = ((recent.data ?? []) as never[]).map((r) => mapInboxRow(r, user.id));
  const waitingItems = ((waiting.data ?? []) as never[]).map((r) => mapInboxRow(r, user.id));
  const c0 = ((counts.data ?? [])[0] ?? {}) as Record<string, number>;

  // Admins only, and an admin's refusal is the database's (42501), not ours.
  const spendShape =
    isAdmin && !spend.error
      ? shapeSpend((spend.data ?? []) as SpendRow[], quoteOf(c.get("entitlements")), days)
      : null;
  if (spend.error && isAdmin) console.error("workspace_spend_daily failed", spend.error);

  const threadsByAgent = new Map(
    ((agentThreads.data ?? []) as Array<{ agent_id: string; threads: number }>).map((r) => [
      r.agent_id,
      r.threads,
    ]),
  );
  const spendByAgent = spendShape
    ? new Map(spendShape.byAgent.map((r) => [r.agentId, r.amount]))
    : null;

  const questions = waitingItems.filter((i) => i.needsYou?.kind === "question").length;
  const approvals = waitingItems.filter((i) => i.needsYou?.kind === "approval").length;

  return c.json({
    user: { name: profile.data?.name ?? null, timezone: profile.data?.timezone ?? null },
    workspace: { name: workspace.data?.name ?? null },
    isAdmin,
    needsYou: {
      total: waitingItems.length,
      questions,
      approvals,
      other: waitingItems.length - questions - approvals,
    },
    threads: { window: c0.threads_window ?? 0, previous: c0.threads_previous ?? 0 },
    routineRuns: {
      total: c0.runs_total ?? 0,
      done: c0.runs_done ?? 0,
      failed: c0.runs_failed ?? 0,
    },
    ...(snapshot.metered && !snapshot.unlimited ? { credits: { balance: snapshot.balance } } : {}),
    ...(spendShape
      ? {
          spend: {
            unit: spendShape.unit,
            window: spendShape.window,
            previousWindow: spendShape.previousWindow,
            daily: spendShape.daily,
            byAgent: spendShape.byAgent,
          },
        }
      : {}),
    agents: agentsNow(
      (agents.data ?? []) as AgentRow[],
      items,
      waitingItems,
      (routines.data ?? []) as RoutineRunning[],
      threadsByAgent,
      spendByAgent,
    ),
    ...(isAdmin && !team.error
      ? {
          team: (
            (team.data ?? []) as Array<{
              user_id: string;
              name: string | null;
              avatar_url: string | null;
              threads: number;
            }>
          )
            .map((t) => ({
              userId: t.user_id,
              name: t.name,
              avatarUrl: t.avatar_url,
              threads: t.threads,
            }))
            .sort((a, b) => b.threads - a.threads),
        }
      : {}),
    activity: activity.error
      ? []
      : shapeActivity((activity.data ?? []) as ActivityRow[]).slice(0, 8),
  });
});

export { home };
