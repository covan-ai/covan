import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient, userClient } from "../supabase";
import { mintDeferredToken } from "../api-keys";
import { entitlementsFor, quoteOf } from "../entitlements";
import { estimateCostUsd } from "../pricing";
import { weeklySummaryEmail, type WeeklyPersonal, type WeeklyUsage } from "../emails/away";
import { appUrlFrom, mailerFrom, type Mailer } from "./mailer";

/**
 * Monday morning (0133): a person's own week, for whoever turned on "Weekly
 * summary" (A16), and credits and threads per agent for the admins of a
 * workspace that turned on "Weekly usage summary" (A9). One email each.
 *
 * Every number is read as its recipient — a short token in their name, held
 * to the workspace — through the same functions Home reads (0124, 0122), so
 * the email says what their Home would have said, and the usage part only
 * reaches somebody the admin-only functions answer.
 */

export const WORKSPACES_PER_TICK = 2;

type Claimed = {
  workspace_id: string;
  name: string;
  week_of: string;
  weekly_usage_email: boolean;
};

export type WeeklyDeps = {
  db: SupabaseClient;
  asMember: (
    user: { id: string; email: string | null },
    workspaceId: string,
  ) => Promise<SupabaseClient>;
  mail: Mailer;
  appUrl: string;
  quote: ((usd: number) => number) | null;
};

export async function runWeeklySummaries(env: RoutineEnv): Promise<{ sent: number }> {
  const mail = mailerFrom(env);
  const secret = (env as { SUPABASE_JWT_SECRET?: string }).SUPABASE_JWT_SECRET;
  // Without mail there is nobody to tell; without the secret nothing can be
  // read as the recipient. Either way nothing is claimed.
  if (!mail || !secret) return { sent: 0 };
  return runWeeklySummariesWith({
    db: serviceClient(env),
    asMember: async (user, workspaceId) =>
      userClient(env as never, await mintDeferredToken(secret, user, workspaceId)),
    mail,
    appUrl: appUrlFrom(env),
    quote: quoteOf(entitlementsFor(env)),
  });
}

export async function runWeeklySummariesWith(deps: WeeklyDeps): Promise<{ sent: number }> {
  const { data, error } = await deps.db.rpc("claim_weekly_summaries", {
    p_limit: WORKSPACES_PER_TICK,
  });
  if (error) {
    console.error("weekly: could not claim", error.code);
    return { sent: 0 };
  }
  let sent = 0;
  for (const ws of (data ?? []) as Claimed[]) {
    try {
      sent += await summariseWorkspace(ws, deps);
    } catch (err) {
      console.error("weekly: a workspace's summaries failed", ws.workspace_id, err);
    }
  }
  return { sent };
}

async function summariseWorkspace(ws: Claimed, deps: WeeklyDeps): Promise<number> {
  const { data: members } = await deps.db
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", ws.workspace_id);
  const ids = (members ?? []).map((m) => m.user_id as string);
  if (ids.length === 0) return 0;
  const { data: prefs } = await deps.db
    .from("notification_preferences")
    .select("user_id, weekly_summary")
    .in("user_id", ids);
  const wantsOwn = new Set(
    (prefs ?? []).filter((p) => p.weekly_summary === true).map((p) => p.user_id as string),
  );

  let usage: WeeklyUsage | null | undefined;
  let sent = 0;
  for (const m of members ?? []) {
    const userId = m.user_id as string;
    const own = wantsOwn.has(userId);
    const admin = ws.weekly_usage_email && m.role === "admin";
    if (!own && !admin) continue;
    try {
      const { data: found } = await deps.db.auth.admin.getUserById(userId);
      const user = found?.user;
      if (!user?.email) continue;
      const db = await deps.asMember({ id: user.id, email: user.email }, ws.workspace_id);
      const personal = own ? await personalWeek(db, ws.workspace_id) : null;
      // The same for every admin: read once, as the first of them.
      if (admin && usage === undefined) usage = await usageWeek(db, ws.workspace_id, deps.quote);
      const forThem = admin ? (usage ?? null) : null;
      if (!personal && !forThem) continue;
      await deps.mail(
        weeklySummaryEmail({
          email: user.email,
          workspaceName: ws.name,
          weekOf: ws.week_of,
          personal,
          usage: forThem,
          url: `${deps.appUrl}/app`,
        }),
      );
      sent++;
    } catch (err) {
      console.error("weekly: could not send one", ws.workspace_id, err);
    }
  }
  return sent;
}

async function personalWeek(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WeeklyPersonal | null> {
  const [counts, inbox] = await Promise.all([
    db.rpc("home_counts", { p_workspace_id: workspaceId, p_days: 7 }),
    db.rpc("inbox_counts", { p_workspace_id: workspaceId }),
  ]);
  if (counts.error || inbox.error) return null;
  const row = (Array.isArray(counts.data) ? counts.data[0] : counts.data) as
    { threads_window: number; runs_done: number; runs_failed: number } | undefined;
  const needsYou = ((inbox.data ?? []) as Array<{ needs_you: number }>).reduce(
    (n, r) => n + (Number(r.needs_you) || 0),
    0,
  );
  return {
    threads: Number(row?.threads_window) || 0,
    needsYou,
    runsDone: Number(row?.runs_done) || 0,
    runsFailed: Number(row?.runs_failed) || 0,
  };
}

type SpendRow = {
  agent_id: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
};

async function usageWeek(
  db: SupabaseClient,
  workspaceId: string,
  quote: ((usd: number) => number) | null,
): Promise<WeeklyUsage | null> {
  const [spend, threads, agents] = await Promise.all([
    db.rpc("workspace_spend_daily", { p_workspace_id: workspaceId, p_days: 7 }),
    db.rpc("home_agent_threads", { p_workspace_id: workspaceId, p_days: 7 }),
    db.from("agents").select("id, name").eq("workspace_id", workspaceId),
  ]);
  if (spend.error || threads.error) return null;
  const usd = new Map<string, number>();
  for (const r of (spend.data ?? []) as SpendRow[]) {
    const cost = estimateCostUsd(
      r.model ?? "",
      Number(r.prompt_tokens) || 0,
      Number(r.completion_tokens) || 0,
      Number(r.cached_tokens) || 0,
      Number(r.cache_write_tokens) || 0,
    );
    usd.set(r.agent_id, (usd.get(r.agent_id) ?? 0) + cost);
  }
  const counts = new Map(
    ((threads.data ?? []) as Array<{ agent_id: string; threads: number }>).map(
      (t) => [t.agent_id, Number(t.threads) || 0] as const,
    ),
  );
  const names = new Map(
    ((agents.data ?? []) as Array<{ id: string; name: string }>).map(
      (a) => [a.id, a.name] as const,
    ),
  );
  const amount = (x: number) => (quote ? Math.round(quote(x)) : Math.round(x * 100) / 100);
  const ids = [...new Set([...usd.keys(), ...counts.keys()])];
  const byAgent = ids
    .map((id) => ({
      name: names.get(id) ?? "A deleted agent",
      threads: counts.get(id) ?? 0,
      amount: amount(usd.get(id) ?? 0),
    }))
    .sort((a, b) => b.amount - a.amount || b.threads - a.threads);
  const total = amount([...usd.values()].reduce((a, b) => a + b, 0));
  return { unit: quote ? "credits" : "usd", total, byAgent };
}
