import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getActiveWorkspaceId } from "../lib/workspace";

const coverage = new Hono<AppEnv>();

/**
 * How the workspace's answers were grounded, over a window.
 *
 * `messages.grounding` (0039) has been recording which of three ways every
 * reply arrived — a passage that cleared the similarity floor, the whole-
 * document fallback, or nothing at all — and until now nothing read it. This
 * is the read, and `0053` is the pair of functions behind it.
 *
 * The number worth the screen is the middle one. A reply that fell back to
 * whole documents is usually still a good answer, and it means no passage in
 * anything the team wrote was close to what was asked: the question the team
 * keeps asking that nobody has written down. That is a thing an admin can act
 * on in an afternoon, which is more than can be said for a token count.
 *
 * **Nothing here is per-person and nothing here is content.** The functions
 * return counts by agent and by bucket; they do not select a `user_id` and
 * they do not return a question. Listing the questions themselves is a
 * separate feature with a consent step in front of it — see the header of
 * `0053` for why that line is where it is.
 */

type CoverageRow = {
  answers: number | string;
  covered: number | string;
  fallback: number | string;
  ungrounded: number | string;
  unrecorded: number | string;
};

type AgentRow = {
  agent_id: string;
  agent_name: string;
  agent_emoji: string | null;
  answers: number | string;
  covered: number | string;
  fallback: number | string;
  ungrounded: number | string;
};

const emptyTotals = { answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 0 };

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * The window, in days.
 *
 * Clamped rather than refused: this is a dashboard, and a 400 because somebody
 * typed `?days=0` into a URL helps nobody. `0053` clamps it again on its own
 * side — a function that reads across every private session in a workspace
 * does not trust a caller to have bounded its argument, and an API key is a
 * caller too.
 */
function windowDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(Math.max(n, 1), MAX_DAYS);
}

/** Postgres `bigint` arrives as a string over PostgREST once it is large. */
const count = (v: number | string | null | undefined): number => Number(v) || 0;

/**
 * A function that is not there yet.
 *
 * CI does not apply migrations, so between merging `0053` and somebody pasting
 * it into the SQL editor the API is deployed against a database that has never
 * heard of these functions. Reported as `available: false` and a 200 rather
 * than a 500, so the interface leaves the section out instead of showing an
 * admin an error about a feature they never asked for. Same handling, and the
 * same two error codes, as `usage.ts`.
 */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

/** The workspace's own refusal, raised inside the function. See 0053. */
function isNotAdmin(error: { code?: string }): boolean {
  return error.code === "42501";
}

// GET /coverage/workspace?days=30 — admin only, and the check that enforces it
// lives in the function rather than here, for the reason `usage.ts` gives: an
// admin's own RLS view excludes exactly the sessions being asked about, so
// this has to be SECURITY DEFINER, and a definer function that trusts its
// caller to have checked is one refactor away from being wrong.
coverage.get("/coverage/workspace", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const days = windowDays(c.req.query("days"));

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json({ available: true, days, totals: emptyTotals, agents: [] });
  }

  const [totals, agents] = await Promise.all([
    db.rpc("workspace_coverage", { p_workspace_id: workspaceId, p_days: days }),
    db.rpc("workspace_coverage_agents", { p_workspace_id: workspaceId, p_days: days }),
  ]);

  const error = totals.error ?? agents.error;
  if (error) {
    if (isNotAdmin(error)) return c.json({ error: "admins only" }, 403);
    if (isMissingFunction(error)) {
      console.warn("coverage functions are not applied yet", error.message);
      return c.json({ available: false, days, totals: emptyTotals, agents: [] });
    }
    console.error("workspace coverage failed", error);
    return c.json({ error: "failed to load coverage" }, 500);
  }

  // `workspace_coverage` returns one row; a workspace with no replies at all
  // still returns it, as five zeroes. The `?? emptyTotals` is for the shape
  // rather than for that case — an RPC that answered with an empty array would
  // otherwise crash the map below on a screen that exists to be reassuring.
  const row = ((totals.data ?? []) as CoverageRow[])[0];

  return c.json({
    available: true,
    days,
    totals: row
      ? {
          answers: count(row.answers),
          covered: count(row.covered),
          fallback: count(row.fallback),
          ungrounded: count(row.ungrounded),
          unrecorded: count(row.unrecorded),
        }
      : emptyTotals,
    agents: ((agents.data ?? []) as AgentRow[]).map((a) => ({
      agentId: a.agent_id,
      name: a.agent_name,
      emoji: a.agent_emoji,
      answers: count(a.answers),
      covered: count(a.covered),
      fallback: count(a.fallback),
      ungrounded: count(a.ungrounded),
    })),
  });
});

export { coverage };
