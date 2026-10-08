import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";

/**
 * The install callback, which is the only place a Slack workspace is bound to a
 * Covan one.
 *
 * `slack_installations.team_id` is globally unique (0044) and this route upserts
 * on it, so the row is a tenancy boundary written by a route that arrives
 * unauthenticated: who it belongs to comes out of `state`, and the only thing
 * `state` is ever checked against is the workspace it names. Every test here is
 * about which workspace ends up holding a team.
 */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

const exchangeSlackCode = vi.fn();
vi.mock("../lib/slack/api", () => ({
  exchangeSlackCode: (...args: unknown[]) => exchangeSlackCode(...args),
}));

const { slackPublic } = await import("./slack");
const { signState } = await import("../lib/connections/oauth-state");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.example.com",
  WORKER_HOST: "api.example.com",
  SLACK_CLIENT_ID: "client-1",
  SLACK_CLIENT_SECRET: "secret-1",
  SLACK_SIGNING_SECRET: "signing-1",
};

/**
 * The service-role client, and what each table answers.
 *
 * `rows` is keyed by table: `workspace_members` decides the caller's role,
 * `slack_installations` is the row that already holds this team (or null), and
 * `agents` is the one the installation will point at. Every write is recorded
 * rather than applied, because what matters in this file is which writes happen
 * at all.
 */
function serviceDb(rows: Record<string, unknown> = {}) {
  const calls: Array<{ table: string; op: string; values?: Record<string, unknown> }> = [];
  serviceFrom.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    const terminal = (op: string, values?: Record<string, unknown>) => {
      calls.push({ table, op, values });
      const answer = {
        eq: () => answer,
        order: () => answer,
        limit: () => answer,
        select: () => answer,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      };
      return answer;
    };
    chain.select = () => terminal("select");
    chain.insert = (values: Record<string, unknown>) => terminal("insert", values);
    chain.update = (values: Record<string, unknown>) => terminal("update", values);
    chain.upsert = (values: Record<string, unknown>) => terminal("upsert", values);
    return chain;
  });
  return calls;
}

function app() {
  const hono = new Hono<AppEnv>();
  hono.route("/", slackPublic);
  return hono;
}

async function callback(workspaceId = "ws-1", userId = "user-1") {
  const state = await signState({ provider: "slack", userId, workspaceId }, KEY);
  return app().request(
    `/slack/callback?code=abc&state=${state}`,
    { redirect: "manual" },
    ENV as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  exchangeSlackCode.mockResolvedValue({
    teamId: "T-ACME",
    teamName: "Acme",
    botUserId: "B-1",
    botToken: "xoxb-fresh",
  });
});

describe("GET /slack/callback", () => {
  const member = { workspace_members: { role: "admin" }, agents: { id: "agent-1" } };

  it("installs a Slack team nobody holds yet", async () => {
    const calls = serviceDb({ ...member, slack_installations: null });

    const res = await callback();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("connected=slack");
    expect(
      calls.find((c) => c.table === "slack_installations" && c.op === "upsert")?.values,
    ).toMatchObject({ workspace_id: "ws-1", team_id: "T-ACME" });
  });

  // Re-installing is the ordinary way to fix a revoked token or add a scope,
  // and it has to keep working — it is the whole reason `onConflict` is there.
  it("lets the workspace that holds a team re-install it", async () => {
    const calls = serviceDb({ ...member, slack_installations: { workspace_id: "ws-1" } });

    const res = await callback("ws-1");

    expect(res.headers.get("location")).toContain("connected=slack");
    expect(calls.some((c) => c.table === "slack_installations" && c.op === "upsert")).toBe(true);
  });

  // Finding 4 in the 2026-10-08 audit. The only authorisation this route
  // performs is that the state's user is an admin of the state's OWN
  // workspace — so an admin of any workspace could install an app into a Slack
  // team another tenant already held, and the upsert would re-point that row,
  // bot token and all, at theirs.
  it("refuses a Slack team another workspace already holds", async () => {
    const calls = serviceDb({ ...member, slack_installations: { workspace_id: "ws-other" } });

    const res = await callback("ws-1");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=team_taken");
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("refuses somebody who is not an admin of the workspace in the state", async () => {
    const calls = serviceDb({ workspace_members: { role: "member" } });

    const res = await callback();

    expect(res.headers.get("location")).toContain("error=admin_only");
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });
});
