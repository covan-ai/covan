import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getActiveWorkspaceId } from "../lib/workspace";
import { resolveModel, type ModelEnv } from "../lib/models";
import { estimateCostUsd } from "../lib/pricing";
import { weighTokens } from "../lib/entitlements";

const usage = new Hono<AppEnv>();

/**
 * What one model's share of a row cost, as `0071`'s functions return it.
 *
 * `model` is null on a reply written before `0065` added the column — 361 rows
 * in production, and no row written after 2026-09-27T19:12Z. A null is
 * therefore "nobody recorded one", not "no model answered", and the only
 * honest price for it is the agent's own.
 */
type ModelShare = {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
};

type UsageRow = {
  agent_id: string;
  agent_name: string;
  agent_emoji: string | null;
  agent_model: string | null;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  measured_prompt_tokens: number;
  /** Absent against a database `0071` has not reached. See `costOf`. */
  by_model?: unknown;
};

type MonthRow = {
  month: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  by_model?: unknown;
};

/**
 * What a row cost, priced by the model that answered each reply in it.
 *
 * WHY THIS IS NOT `estimateCostUsd(agentModel, …)`. It was, and covan#208 is
 * what that produced: every reply priced at the agent's model **today**, joined
 * through `chat_sessions.agent_id → agents.model`. An agent moved from gpt-5 to
 * Sonnet took its whole history onto Sonnet's price list, and `0065`'s header
 * names the shape that makes it visible — a gpt-5 agent carrying 19,704
 * `cache_write_tokens`, a number OpenAI does not report.
 *
 * Returns null when the column is absent rather than 0. CI never applies
 * migrations, so there is a window where this code runs against a schema
 * without `by_model`, and in that window the caller falls back to the old
 * reading. Zero would be a claim that the month was free.
 */
function costOf(byModel: unknown, fallbackModel: string | null): number | null {
  if (!Array.isArray(byModel)) return null;
  let total = 0;
  for (const raw of byModel) {
    if (!raw || typeof raw !== "object") continue;
    const share = raw as Partial<ModelShare>;
    total += estimateCostUsd(
      // The recorded id, NOT `resolveModel`'d. That function answers "what
      // would serve a request now" — it turns a Claude pick into the default
      // on a deployment with no Anthropic key — and a reply that has already
      // been answered and billed is not asking that question. Routing it
      // through there is what priced every Anthropic reply at gpt-4.1: 64 of
      // the 66 turns in the week to 2026-10-04 are Anthropic, Sonnet 5 bills
      // $10/M out against gpt-4.1's $8 and Opus 5 bills $25, and a cached
      // Anthropic token is $0.20 against gpt-4.1's $0.50. `estimateCostUsd`
      // takes an unknown id to `DEFAULT_PRICE` on its own, which is the
      // behaviour this wants.
      //
      // The fallback is per share, not per row: one agent holds both replies
      // that recorded a model and replies that predate the column.
      share.model ?? fallbackModel ?? "",
      Number(share.promptTokens) || 0,
      Number(share.completionTokens) || 0,
      Number(share.cachedTokens) || 0,
      Number(share.cacheWriteTokens) || 0,
    );
  }
  return total;
}

const emptyTotals = {
  messageCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  measuredPromptTokens: 0,
  totalTokens: 0,
  weightedTokens: 0,
  estCostUsd: 0,
};

/** One agent's row, priced. Shared by the per-caller and workspace-wide reads,
    which return identical columns on purpose so one renderer can read either. */
function mapAgent(r: UsageRow, env?: ModelEnv) {
  // What this deployment will actually answer with, which is the question this
  // field is for — an agent set to Claude on an install with no Anthropic key
  // answers with the default, and saying so is the point of resolving it.
  // Passed the env, because without it every Anthropic agent resolved to the
  // default and the screen named the wrong model on every Claude row.
  const model = resolveModel(r.agent_model, env);
  const promptTokens = Number(r.prompt_tokens) || 0;
  const completionTokens = Number(r.completion_tokens) || 0;
  // A subset of promptTokens, so it is priced into estCostUsd rather than
  // added to totalTokens — the total is how many tokens moved, the cost is
  // what they were billed at, and only the second one knows about caching.
  // Replies from before 0025 report null here and sum as 0, which reads as
  // "no discount recorded" and leaves their historical figure unchanged.
  const cachedTokens = Number(r.cached_tokens) || 0;
  // A subset on the same terms and disjoint from the one above: a token is
  // read from the cache or written into it, never both. Priced at 1.25x input
  // rather than at `in`, which is the difference between a caching change that
  // looks like a saving and one that is. Zero on every OpenAI reply and on
  // every reply written before 0062. See 0062.
  const cacheWriteTokens = Number(r.cache_write_tokens) || 0;
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
    cacheWriteTokens,
    measuredPromptTokens,
    totalTokens: promptTokens + completionTokens,
    // What those tokens cost the allowance, as against how many of them moved.
    // Sent rather than left for the client to work out, so the screen that
    // turns an allowance into "replies left" divides by the same number the
    // counter is charged — see `weighTokens`, and `src/lib/quota.ts` for what
    // the two disagreeing looked like.
    weightedTokens: weighTokens({
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
    }),
    // Priced by what answered, not by `model` above — which is what the agent
    // is set to now, and therefore what it will answer with NEXT. The two
    // disagreeing on a row is the fact rather than a glitch: see `costOf`.
    estCostUsd:
      costOf(r.by_model, r.agent_model) ??
      estimateCostUsd(
        r.agent_model ?? "",
        promptTokens,
        completionTokens,
        cachedTokens,
        cacheWriteTokens,
      ),
  };
}

function sumTotals(agents: ReturnType<typeof mapAgent>[]) {
  return agents.reduce(
    (acc, a) => ({
      messageCount: acc.messageCount + a.messageCount,
      promptTokens: acc.promptTokens + a.promptTokens,
      completionTokens: acc.completionTokens + a.completionTokens,
      cachedTokens: acc.cachedTokens + a.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + a.cacheWriteTokens,
      measuredPromptTokens: acc.measuredPromptTokens + a.measuredPromptTokens,
      totalTokens: acc.totalTokens + a.totalTokens,
      weightedTokens: acc.weightedTokens + a.weightedTokens,
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

  const agents = ((data ?? []) as UsageRow[]).map((r) => mapAgent(r, c.env));
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

  const agents = ((wide.data ?? []) as UsageRow[]).map((r) => mapAgent(r, c.env));
  const months = ((monthly.data ?? []) as MonthRow[]).map((m) => {
    const promptTokens = Number(m.prompt_tokens) || 0;
    const completionTokens = Number(m.completion_tokens) || 0;
    const cost = costOf(m.by_model, null);
    return {
      month: m.month,
      messageCount: Number(m.message_count) || 0,
      totalTokens: promptTokens + completionTokens,
      cachedTokens: Number(m.cached_tokens) || 0,
      cacheWriteTokens: Number(m.cache_write_tokens) || 0,
      // A month CAN be priced now, which it could not be when this shape was
      // written: there was no per-reply model, so the only available answer was
      // "assume every reply came from whatever its agent is set to today" —
      // across six months, the one assumption most likely to be wrong. `0071`
      // groups each bucket by the model that answered.
      //
      // Spread rather than set, so a database without `0071` returns a month
      // with no cost at all instead of a free one. There is no agent to fall
      // back to at this grain; a month is every agent at once.
      ...(cost === null ? {} : { estCostUsd: cost }),
    };
  });

  return c.json({ available: true, agents, totals: sumTotals(agents), months });
});

export { usage };
