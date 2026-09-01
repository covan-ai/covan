import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getActiveWorkspaceId } from "../lib/workspace";
import { resolveModel } from "../lib/models";
import { estimateCostUsd } from "../lib/pricing";

const usage = new Hono<AppEnv>();

type UsageRow = {
  agent_id: string;
  agent_name: string;
  agent_emoji: string | null;
  agent_model: string | null;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  measured_prompt_tokens: number;
};

type MonthRow = {
  month: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
};

const emptyTotals = {
  messageCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 0,
  estCostUsd: 0,
};

/** One agent's row, priced. Shared by the per-caller and workspace-wide reads,
    which return identical columns on purpose so one renderer can read either. */
function mapAgent(r: UsageRow) {
  const model = resolveModel(r.agent_model);
  const promptTokens = Number(r.prompt_tokens) || 0;
  const completionTokens = Number(r.completion_tokens) || 0;
  // A subset of promptTokens, so it is priced into estCostUsd rather than
  // added to totalTokens — the total is how many tokens moved, the cost is
  // what they were billed at, and only the second one knows about caching.
  // Replies from before 0025 report null here and sum as 0, which reads as
  // "no discount recorded" and leaves their historical figure unchanged.
  const cachedTokens = Number(r.cached_tokens) || 0;
  // Only the prompt tokens on replies that carry a cache measurement — the
  // honest denominator for a hit rate. See 0025.
  const measuredPromptTokens = Number(r.measured_prompt_tokens) || 0;
  return {
    agentId: r.agent_id,
    name: r.agent_name,
    emoji: r.agent_emoji,
    model,
    messageCount: Number(r.message_count) || 0,
    promptTokens,
    completionTokens,
    cachedTokens,
    measuredPromptTokens,
    totalTokens: promptTokens + completionTokens,
    estCostUsd: estimateCostUsd(model, promptTokens, completionTokens, cachedTokens),
  };
}

function sumTotals(agents: ReturnType<typeof mapAgent>[]) {
  return agents.reduce(
    (acc, a) => ({
      messageCount: acc.messageCount + a.messageCount,
      promptTokens: acc.promptTokens + a.promptTokens,
      completionTokens: acc.completionTokens + a.completionTokens,
      cachedTokens: acc.cachedTokens + a.cachedTokens,
      measuredPromptTokens: acc.measuredPromptTokens + a.measuredPromptTokens,
      totalTokens: acc.totalTokens + a.totalTokens,
      estCostUsd: acc.estCostUsd + a.estCostUsd,
    }),
    { ...emptyTotals },
  );
}

// GET /usage — per-agent message + token totals and an estimated cost, scoped
// to the active workspace. Sessions are private per user (RLS), so figures
// reflect the caller's own conversations.
usage.get("/usage", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  // What this user may still spend. `limit: null` on an unmetered install, and
  // the interface renders nothing for it.
  const quota = await c
    .get("entitlements")
    .snapshot(user.id)
    .catch((err) => {
      console.error("quota snapshot failed", err);
      return { used: 0, limit: null, resetsAt: null };
    });

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ agents: [], totals: emptyTotals, quota });

  const { data, error } = await db.rpc("workspace_usage", { p_workspace_id: workspaceId });
  if (error) {
    console.error("workspace_usage failed", error);
    return c.json({ error: "failed to load usage" }, 500);
  }

  const agents = ((data ?? []) as UsageRow[]).map(mapAgent);
  return c.json({ agents, totals: sumTotals(agents), quota });
});

/**
 * A function that is not there yet.
 *
 * CI does not apply migrations, so between merging `0032` and somebody pasting
 * it into the SQL editor the API is deployed against a database that has never
 * heard of these functions. PostgREST answers that with `PGRST202` (nothing by
 * that name in the schema cache) or, once found but mismatched, `42883`.
 *
 * That window is reported as `available: false` and a 200 rather than a 500,
 * so the interface can leave the section out instead of showing an admin an
 * error about a feature they never asked for. It is the difference between "we
 * have not finished deploying" and "something is broken".
 */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

/** The workspace's own refusal, raised inside the function. See 0032. */
function isNotAdmin(error: { code?: string }): boolean {
  return error.code === "42501";
}

// GET /usage/workspace — the same per-agent shape as above, but across
// everybody's conversations, plus a month-by-month trend. Admin only, and the
// check that enforces it lives in the function rather than here: an admin's own
// RLS view excludes exactly the sessions being asked about, so this has to be
// SECURITY DEFINER, and a definer function that trusts its caller to have
// checked is one refactor away from being wrong.
//
// There is nothing per-person in the response, by construction — see 0032.
usage.get("/usage/workspace", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ available: true, agents: [], totals: emptyTotals, months: [] });

  const [wide, monthly] = await Promise.all([
    db.rpc("workspace_usage_all", { p_workspace_id: workspaceId }),
    db.rpc("workspace_usage_monthly", { p_workspace_id: workspaceId, p_months: 6 }),
  ]);

  const error = wide.error ?? monthly.error;
  if (error) {
    if (isNotAdmin(error)) return c.json({ error: "admins only" }, 403);
    if (isMissingFunction(error)) {
      console.warn("workspace usage functions are not applied yet", error.message);
      return c.json({ available: false, agents: [], totals: emptyTotals, months: [] });
    }
    console.error("workspace usage failed", error);
    return c.json({ error: "failed to load usage" }, 500);
  }

  const agents = ((wide.data ?? []) as UsageRow[]).map(mapAgent);
  const months = ((monthly.data ?? []) as MonthRow[]).map((m) => {
    const promptTokens = Number(m.prompt_tokens) || 0;
    const completionTokens = Number(m.completion_tokens) || 0;
    return {
      month: m.month,
      messageCount: Number(m.message_count) || 0,
      // No cost here, and not an oversight: `messages` records no model, so a
      // month's tokens cannot be priced without assuming every reply in it
      // came from whatever the agent is set to today. Tokens are the honest
      // figure at this grain; the per-agent rows above carry the money.
      totalTokens: promptTokens + completionTokens,
      cachedTokens: Number(m.cached_tokens) || 0,
    };
  });

  return c.json({ available: true, agents, totals: sumTotals(agents), months });
});

export { usage };
