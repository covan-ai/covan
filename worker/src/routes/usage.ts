import { Hono } from "hono";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { resolveModel, type ModelEnv } from "../lib/models";
import { estimateCostUsd } from "../lib/pricing";
import { quoteOf, type CreditSnapshot } from "../lib/entitlements";

const usage = new Hono<AppEnv>();

/**
 * What one model's share of a row cost, as `0071`'s functions return it.
 *
 * `model` is null on a reply written before `0065` added the column — 183 of
 * production's 254 assistant replies, and none written after
 * 2026-09-27T19:12Z. A null is therefore "nobody recorded one", not "no model
 * answered", and the only honest price for it is the agent's own.
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
  estCostUsd: 0,
};

/** One agent's row, priced. Shared by the per-caller and workspace-wide reads,
    which return identical columns on purpose so one renderer can read either. */
type Quote = ((usd: number) => number) | null;

function mapAgent(r: UsageRow, env?: ModelEnv, quote: Quote = null) {
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
  // Priced by what answered, not by `model` above — which is what the agent
  // is set to now, and therefore what it will answer with NEXT. The two
  // disagreeing on a row is the fact rather than a glitch: see `costOf`.
  const estCostUsd =
    costOf(r.by_model, r.agent_model) ??
    estimateCostUsd(
      r.agent_model ?? "",
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
    );
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
    estCostUsd,
    // The same estimate in credits, from the hosted build alone. Absent on an
    // install with no credits, and the screen shows dollars there instead.
    ...(quote ? { estCredits: quote(estCostUsd) } : {}),
  };
}

function sumTotals(agents: ReturnType<typeof mapAgent>[], quote: Quote = null) {
  const totals = agents.reduce(
    (acc, a) => ({
      messageCount: acc.messageCount + a.messageCount,
      promptTokens: acc.promptTokens + a.promptTokens,
      completionTokens: acc.completionTokens + a.completionTokens,
      cachedTokens: acc.cachedTokens + a.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + a.cacheWriteTokens,
      measuredPromptTokens: acc.measuredPromptTokens + a.measuredPromptTokens,
      totalTokens: acc.totalTokens + a.totalTokens,
      estCostUsd: acc.estCostUsd + a.estCostUsd,
    }),
    { ...emptyTotals },
  );
  // Quoted on the sum rather than summed over the quotes: the same number,
  // because the conversion is a factor, and one call rather than one per row.
  return quote ? { ...totals, estCredits: quote(totals.estCostUsd) } : totals;
}

// GET /usage — per-agent message + token totals and an estimated cost, scoped
// to the active workspace. Sessions are private per user (RLS), so figures
// reflect the caller's own conversations.
usage.get("/usage", async (c) => {
  const db = c.get("db");

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) {
    return c.json({ agents: [], totals: emptyTotals, credits: { metered: false } });
  }

  const credits = await creditsOf(c.get("entitlements"), workspaceId);
  const quote = quoteOf(c.get("entitlements"));

  const { data, error } = await db.rpc("workspace_usage", { p_workspace_id: workspaceId });
  if (error) {
    console.error("workspace_usage failed", error);
    return c.json({ error: "failed to load usage" }, 500);
  }

  const agents = ((data ?? []) as UsageRow[]).map((r) => mapAgent(r, c.env, quote));
  return c.json({ agents, totals: sumTotals(agents, quote), credits });
});

/**
 * What the active workspace has left. `metered: false` on an unmetered install
 * and on a failed read, and the interface renders nothing for it: a balance
 * nobody could read is not a balance of zero.
 */
async function creditsOf(
  entitlements: { snapshot(workspaceId: string): Promise<CreditSnapshot> },
  workspaceId: string,
): Promise<CreditSnapshot> {
  try {
    return await entitlements.snapshot(workspaceId);
  } catch (err) {
    console.error("credit snapshot failed", err);
    return { metered: false };
  }
}

/** How many ledger rows one request may ask for. */
const LEDGER_MAX = 100;

/** How many rows "Export CSV" carries — a year of a busy workspace. */
const LEDGER_CSV_MAX = 5000;

/** The hosted ledger's unit: a credit is a million of them. */
const MICRO = 1_000_000;

type LedgerRow = {
  id: number;
  created_at: string;
  kind: string;
  model: string | null;
  purpose: string | null;
  delta_micro: number | string;
  balance_after: number | string;
  note: string | null;
  session_id: string | null;
  routine_run_id: string | null;
};

export type LedgerEntryDTO = {
  id: number;
  at: string;
  kind: string;
  model: string | null;
  purpose: string | null;
  credits: number;
  balanceAfter: number;
  note: string | null;
  sessionId: string | null;
  /** Absent when the thread is somebody's private one, or gone. */
  sessionTitle?: string;
  routineId?: string;
  routineName?: string;
  agentId?: string;
  agentName?: string;
  agentAvatar?: string | null;
  /** Who started the thread a charge belongs to; a routine's charges say "routine". */
  by?: { kind: "person"; name: string } | { kind: "routine" };
};

const LEDGER_COLUMNS =
  "id, created_at, kind, model, purpose, delta_micro, balance_after, note, session_id, routine_run_id";

/**
 * What each row was for, read through the caller's own client: the thread's
 * title and owner, the routine's name, the agent. A private thread of somebody
 * else's stays unnamed — the policy that hides it from the admin hides it here
 * too, and the row keeps its amount.
 */
async function describeLedger(
  db: AppEnv["Variables"]["db"],
  rows: LedgerRow[],
): Promise<LedgerEntryDTO[]> {
  const ids = (pick: (r: LedgerRow) => string | null) => [
    ...new Set(rows.map(pick).filter((v): v is string => !!v)),
  ];
  const sessionIds = ids((r) => r.session_id);
  const runIds = ids((r) => r.routine_run_id);

  const [sessions, runs] = await Promise.all([
    sessionIds.length
      ? db
          .from("chat_sessions")
          .select("id, title, agent_id, user_id, routine_id")
          .in("id", sessionIds)
      : { data: [] },
    runIds.length
      ? db.from("routine_runs").select("id, routine_id").in("id", runIds)
      : { data: [] },
  ]);
  type S = {
    id: string;
    title: string | null;
    agent_id: string;
    user_id: string;
    routine_id: string | null;
  };
  const sessionById = new Map(((sessions.data ?? []) as S[]).map((s) => [s.id, s]));
  const runRoutine = new Map(
    ((runs.data ?? []) as Array<{ id: string; routine_id: string }>).map((r) => [
      r.id,
      r.routine_id,
    ]),
  );

  const routineIds = [
    ...new Set([
      ...runRoutine.values(),
      ...[...sessionById.values()].map((s) => s.routine_id).filter((v): v is string => !!v),
    ]),
  ];
  const routines = routineIds.length
    ? await db.from("routines").select("id, name, agent_id").in("id", routineIds)
    : { data: [] };
  const routineById = new Map(
    ((routines.data ?? []) as Array<{ id: string; name: string; agent_id: string }>).map((r) => [
      r.id,
      r,
    ]),
  );

  const agentIds = [
    ...new Set([
      ...[...sessionById.values()].map((s) => s.agent_id),
      ...[...routineById.values()].map((r) => r.agent_id),
    ]),
  ];
  const ownerIds = [...new Set([...sessionById.values()].map((s) => s.user_id))];
  const [agents, people] = await Promise.all([
    agentIds.length
      ? db.from("agents").select("id, name, avatar").in("id", agentIds)
      : { data: [] },
    ownerIds.length ? db.from("profiles").select("id, name").in("id", ownerIds) : { data: [] },
  ]);
  const agentById = new Map(
    ((agents.data ?? []) as Array<{ id: string; name: string; avatar: string | null }>).map((a) => [
      a.id,
      a,
    ]),
  );
  const nameById = new Map(
    ((people.data ?? []) as Array<{ id: string; name: string | null }>).map((p) => [p.id, p.name]),
  );

  return rows.map((r) => {
    const session = r.session_id ? sessionById.get(r.session_id) : undefined;
    const routineId =
      (r.routine_run_id ? runRoutine.get(r.routine_run_id) : undefined) ??
      session?.routine_id ??
      undefined;
    const routine = routineId ? routineById.get(routineId) : undefined;
    const agentId = session?.agent_id ?? routine?.agent_id;
    const agent = agentId ? agentById.get(agentId) : undefined;
    const entry: LedgerEntryDTO = {
      id: r.id,
      at: r.created_at,
      kind: r.kind,
      model: r.model,
      purpose: r.purpose,
      credits: Number(r.delta_micro) / MICRO,
      balanceAfter: Number(r.balance_after) / MICRO,
      note: r.note,
      sessionId: r.session_id,
    };
    if (session && !routine) entry.sessionTitle = session.title ?? "Untitled thread";
    if (routine) {
      entry.routineId = routine.id;
      entry.routineName = routine.name;
      entry.by = { kind: "routine" };
    } else if (session) {
      const name = nameById.get(session.user_id);
      if (name) entry.by = { kind: "person", name };
    }
    if (agent) {
      entry.agentId = agent.id;
      entry.agentName = agent.name;
      entry.agentAvatar = agent.avatar;
    }
    return entry;
  });
}

/** One CSV cell, quoted when it has to be, and never read as a formula. */
function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function ledgerCsv(entries: LedgerEntryDTO[]): string {
  const head = [
    "When",
    "Kind",
    "Purpose",
    "Entry",
    "Agent",
    "By",
    "Model",
    "Credits",
    "Balance after",
  ];
  const lines = entries.map((e) =>
    [
      e.at,
      e.kind,
      e.purpose ?? "",
      e.routineName ?? e.sessionTitle ?? e.note ?? "",
      e.agentName ?? "",
      e.by?.kind === "routine" ? "Routine" : e.by?.kind === "person" ? e.by.name : "",
      e.model ?? "",
      Math.round(e.credits * 100) / 100,
      Math.round(e.balanceAfter * 100) / 100,
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// GET /usage/credits/ledger — the active workspace's recent charges and grants.
//
// Only the hosted build keeps a ledger; everywhere else this answers an empty
// list rather than probing for a table that was never created. Read through
// the caller's own client, so the policy decides who may see it — admins only.
// `user_id` stays withheld by its column grant; "By" is the owner of the
// thread a charge belongs to, which the admin's own policies decide whether
// they may know. `before` pages by id; `format=csv` is "Export CSV".
usage.get("/usage/credits/ledger", async (c) => {
  const db = c.get("db");
  const csv = c.req.query("format") === "csv";

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ entries: [], hasMore: false });

  const credits = await creditsOf(c.get("entitlements"), workspaceId);
  if (!credits.metered) {
    if (csv) return c.json({ error: "this deployment keeps no ledger" }, 404);
    return c.json({ entries: [], hasMore: false });
  }

  const asked = Number(c.req.query("limit"));
  const max = csv ? LEDGER_CSV_MAX : LEDGER_MAX;
  const limit =
    Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), max) : csv ? max : 50;
  const before = Number(c.req.query("before"));

  let q = db.from("credit_ledger").select(LEDGER_COLUMNS).eq("workspace_id", workspaceId);
  if (Number.isFinite(before) && before > 0) q = q.lt("id", before);
  const { data, error } = await q.order("id", { ascending: false }).limit(limit + 1);
  if (error) {
    console.error("credit ledger read failed", error);
    return c.json({ error: "failed to load the ledger" }, 500);
  }

  const rows = (data ?? []) as LedgerRow[];
  const entries = await describeLedger(db, rows.slice(0, limit));
  if (csv) {
    return c.body(ledgerCsv(entries), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="covan-credits-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }
  return c.json({ entries, hasMore: rows.length > limit });
});

type SpendRow = {
  day: string;
  agent_id: string;
  model: string | null;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  cached_tokens: number | string;
  cache_write_tokens: number | string;
};

/** The first of this month, UTC, and how many days of it there have been. */
export function monthSoFar(now: Date = new Date()): { since: string; days: number } {
  return {
    since: `${now.toISOString().slice(0, 8)}01`,
    days: now.getUTCDate(),
  };
}

// GET /usage/credits/month — "This month by agent" (A15) and "N used this
// month": every reply and routine run since the first, priced from what the
// models were paid and quoted in credits where the deployment sells them.
// Admins only, like the spend on Home (0124); a member's 403 hides the section.
usage.get("/usage/credits/month", async (c) => {
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const { since, days } = monthSoFar();
  const [spend, agents] = await Promise.all([
    db.rpc("workspace_spend_daily", { p_workspace_id: workspaceId, p_days: days }),
    db.from("agents").select("id, name, avatar").eq("workspace_id", workspaceId),
  ]);
  if (spend.error) {
    if (isNotAdmin(spend.error)) return c.json({ error: "admins only" }, 403);
    if (isMissingFunction(spend.error)) return c.json({ available: false });
    console.error("workspace_spend_daily failed", spend.error);
    return c.json({ error: "failed to load this month" }, 500);
  }

  const quote = quoteOf(c.get("entitlements"));
  const usdByAgent = new Map<string, number>();
  for (const r of (spend.data ?? []) as SpendRow[]) {
    if (String(r.day).slice(0, 10) < since) continue;
    const usd = estimateCostUsd(
      r.model ?? "",
      Number(r.prompt_tokens) || 0,
      Number(r.completion_tokens) || 0,
      Number(r.cached_tokens) || 0,
      Number(r.cache_write_tokens) || 0,
    );
    usdByAgent.set(r.agent_id, (usdByAgent.get(r.agent_id) ?? 0) + usd);
  }
  const amount = (usd: number) => (quote ? Math.round(quote(usd)) : Math.round(usd * 100) / 100);
  const named = new Map(
    ((agents.data ?? []) as Array<{ id: string; name: string; avatar: string | null }>).map((a) => [
      a.id,
      a,
    ]),
  );
  let total = 0;
  for (const usd of usdByAgent.values()) total += usd;

  return c.json({
    available: true,
    since,
    unit: quote ? ("credits" as const) : ("usd" as const),
    spent: amount(total),
    byAgent: [...usdByAgent.entries()]
      .map(([agentId, usd]) => ({
        agentId,
        name: named.get(agentId)?.name ?? "A deleted agent",
        avatar: named.get(agentId)?.avatar ?? null,
        amount: amount(usd),
      }))
      .filter((a) => a.amount > 0)
      .sort((a, b) => b.amount - a.amount),
  });
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

  const workspaceId = await callerWorkspaceId(c);
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

  const quote = quoteOf(c.get("entitlements"));
  const agents = ((wide.data ?? []) as UsageRow[]).map((r) => mapAgent(r, c.env, quote));
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
      ...(cost === null ? {} : { estCostUsd: cost, ...(quote ? { estCredits: quote(cost) } : {}) }),
    };
  });

  return c.json({ available: true, agents, totals: sumTotals(agents, quote), months });
});

export { usage };
