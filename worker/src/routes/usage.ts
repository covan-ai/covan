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

const emptyTotals = {
  messageCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 0,
  estCostUsd: 0,
};

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

  const agents = ((data ?? []) as UsageRow[]).map((r) => {
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
  });

  const totals = agents.reduce(
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

  return c.json({ agents, totals, quota });
});

export { usage };
