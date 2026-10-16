import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { memoryDb } from "../test-support/memory-db";

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

const handleSlackEvent = vi.fn(async () => {});
vi.mock("../lib/slack/handle", () => ({
  handleSlackEvent: (...args: unknown[]) => handleSlackEvent(...(args as [])),
}));
const deliverSlackEvent = vi.fn(async () => {});
vi.mock("../lib/routines/events/slack-deliver", () => ({
  deliverSlackEvent: (...args: unknown[]) => deliverSlackEvent(...(args as [])),
}));
const lapseSubscriptions = vi.fn(async () => [] as string[]);
vi.mock("../lib/routines/events/lifecycle", () => ({
  lapseSubscriptions: (...args: unknown[]) => lapseSubscriptions(...(args as [])),
}));

const { slack, slackPublic } = await import("./slack");
const { resetRateLimiters } = await import("../lib/ratelimit");
const { resetMisses } = await import("../middleware/ratelimit");
const { signState, readState, sealGrant, nonceHashOf } =
  await import("../lib/connections/oauth-state");

/** What the tab that started the install keeps, and the hash it sent. */
const NONCE = "nonce-of-the-starting-tab-0123456789";
const NONCE_HASH = await nonceHashOf(NONCE);

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
        is: () => answer,
        not: () => answer,
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

/** Both routers, with `caller` signed in for the authenticated one. */
function app(caller = "user-1") {
  const hono = new Hono<AppEnv>();
  hono.use("/slack/complete", async (c, next) => {
    c.set("user", { id: caller, email: `${caller}@example.com` } as never);
    await next();
  });
  hono.route("/", slack);
  hono.route("/", slackPublic);
  return hono;
}

async function callback(workspaceId = "ws-1", userId = "user-1") {
  const state = await signState(
    { provider: "slack", userId, workspaceId, nonceHash: NONCE_HASH },
    KEY,
  );
  return app().request(
    `/slack/callback?code=abc&state=${state}`,
    { redirect: "manual" },
    ENV as never,
  );
}

/** The grant the callback seals, completed by `caller` with `nonce`. */
async function complete(
  opts: { workspaceId?: string; starter?: string; caller?: string; nonce?: string } = {},
) {
  const raw = await signState(
    {
      provider: "slack",
      userId: opts.starter ?? "user-1",
      workspaceId: opts.workspaceId ?? "ws-1",
      nonceHash: NONCE_HASH,
    },
    KEY,
  );
  const grant = await sealGrant(
    {
      state: (await readState(raw, KEY))!,
      code: "abc",
      redirectUri: "https://api.example.com/slack/callback",
    },
    KEY,
  );
  return app(opts.caller ?? "user-1").request(
    "/slack/complete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant, nonce: opts.nonce ?? NONCE }),
    },
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
    scopes: ["app_mentions:read", "channels:history"],
  });
});

describe("GET /slack/callback", () => {
  it("seals the code for the app and installs nothing", async () => {
    // Who is at this browser is unknown. Installing here is what let a consent
    // link sent to another team's admin bind their Slack to the starter.
    const calls = serviceDb({});

    const res = await callback();

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("for")).toBe("slack");
    expect(location.searchParams.get("grant")).toBeTruthy();
    expect(exchangeSlackCode).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("POST /slack/complete", () => {
  const member = { workspace_members: { role: "admin" }, agents: { id: "agent-1" } };

  it("installs a Slack team nobody holds yet", async () => {
    const calls = serviceDb({ ...member, slack_installations: null });

    const res = await complete();

    expect(res.status).toBe(200);
    expect(
      calls.find((c) => c.table === "slack_installations" && c.op === "upsert")?.values,
    ).toMatchObject({
      workspace_id: "ws-1",
      team_id: "T-ACME",
      // What Slack granted, recorded so a reconnect can be asked for (0112).
      scopes: ["app_mentions:read", "channels:history"],
    });
  });

  it("refuses an install somebody else started, before exchanging anything", async () => {
    const calls = serviceDb({ ...member, slack_installations: null });

    const res = await complete({ starter: "user-attacker" });

    expect(res.status).toBe(403);
    expect(exchangeSlackCode).not.toHaveBeenCalled();
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("refuses without the nonce of the tab that started it", async () => {
    serviceDb(member);
    const res = await complete({ nonce: "a-different-tab-nonce-0123456789" });
    expect(res.status).toBe(403);
    expect(exchangeSlackCode).not.toHaveBeenCalled();
  });

  // Re-installing is the ordinary way to fix a revoked token or add a scope,
  // and it has to keep working — it is the whole reason `onConflict` is there.
  it("lets the workspace that holds a team re-install it", async () => {
    const calls = serviceDb({ ...member, slack_installations: { workspace_id: "ws-1" } });

    const res = await complete({ workspaceId: "ws-1" });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.table === "slack_installations" && c.op === "upsert")).toBe(true);
  });

  // Finding 4 in the 2026-10-08 audit: a team another tenant already holds is
  // not re-pointed at this one.
  it("refuses a Slack team another workspace already holds", async () => {
    const calls = serviceDb({ ...member, slack_installations: { workspace_id: "ws-other" } });

    const res = await complete({ workspaceId: "ws-1" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "team_taken" });
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("refuses somebody who is not an admin of the workspace in the state", async () => {
    const calls = serviceDb({ workspace_members: { role: "member" } });

    const res = await complete();

    expect(await res.json()).toEqual({ error: "admin_only" });
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });
});

describe("POST /slack/events, in front of the per-address limit", () => {
  // Slack delivers every customer's events from the same few addresses, so the
  // route counts by what the signature vouches for — the team — and charges an
  // address only for signatures that fail.
  beforeEach(() => {
    resetRateLimiters();
    resetMisses();
    serviceDb();
  });

  async function event(teamId: string, opts: { sign?: boolean; from?: string } = {}) {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event: { type: "app_mention", user: "U1", channel: "C1", text: "hi", ts: "1.0" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ENV.SLACK_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)),
    );
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    return app().request(
      "/slack/events",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": opts.from ?? "54.0.0.1",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": opts.sign === false ? "v0=00" : `v0=${hex}`,
        },
      },
      { ...ENV, RATE_LIMIT_STANDARD_PER_MINUTE: "2" } as never,
    );
  }

  it("counts verified events per team, not per Slack's shared address", async () => {
    for (const team of ["T1", "T2", "T3", "T4"]) {
      expect((await event(team)).status).toBe(200);
    }
    const lookups = serviceFrom.mock.calls.filter(([t]) => t === "slack_installations").length;
    expect(lookups).toBe(4);
  });

  it("acknowledges and drops a team's events past its rate", async () => {
    await event("T1");
    await event("T1");
    serviceFrom.mockClear();

    const over = await event("T1");

    // 200, because Slack switches off an app whose deliveries keep failing.
    expect(over.status).toBe(200);
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("refuses an address that keeps failing the signature", async () => {
    const from = "203.0.113.20";
    expect((await event("T1", { sign: false, from })).status).toBe(401);
    expect((await event("T1", { sign: false, from })).status).toBe(401);
    expect((await event("T1", { sign: false, from })).status).toBe(401);
    // Spent: refused before the body is read, even with a good signature.
    expect((await event("T1", { from })).status).toBe(429);
    // Slack's own address is untouched.
    expect((await event("T1")).status).toBe(200);
  });
});

describe("POST /slack/events, for routines waiting on Slack activity", () => {
  beforeEach(() => {
    resetRateLimiters();
    resetMisses();
  });

  async function signedEvent(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ENV.SLACK_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)),
    );
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    return app().request(
      "/slack/events",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": `v0=${hex}`,
        },
      },
      ENV as never,
    );
  }

  it("hands every event to the answer flow and to the routines, side by side", async () => {
    const installation = { id: "inst-1", team_id: "T1", workspace_id: "ws-1", bot_user_id: "UBOT" };
    serviceDb({ slack_installations: installation });
    const event = {
      type: "message",
      channel_type: "channel",
      channel: "C1",
      user: "U1",
      text: "hi",
      ts: "1.0",
    };

    const res = await signedEvent({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev42",
      event,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(handleSlackEvent).toHaveBeenCalledWith(installation, event, expect.anything());
    expect(deliverSlackEvent).toHaveBeenCalledWith(
      expect.anything(),
      installation,
      event,
      "Ev42",
      expect.objectContaining({ defer: expect.any(Function), run: expect.any(Function) }),
    );
  });

  it("still answers when the routines' side fails", async () => {
    serviceDb({ slack_installations: { id: "inst-1", team_id: "T1", workspace_id: "ws-1" } });
    deliverSlackEvent.mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await signedEvent({
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_mention", user: "U1", channel: "C1", text: "hi", ts: "1.0" },
    });
    await new Promise((r) => setTimeout(r, 0));
    error.mockRestore();

    expect(handleSlackEvent).toHaveBeenCalledOnce();
  });
});

describe("the installation, for routines waiting on Slack activity", () => {
  /** The caller's own client: a member of ws-1, whose Slack is `install`. */
  function signedIn(install: Record<string, unknown>) {
    const m = memoryDb({
      profiles: [{ id: "user-1", active_workspace_id: "ws-1" }],
      workspace_members: [{ workspace_id: "ws-1", user_id: "user-1", role: "admin" }],
      slack_installations: [install],
    });
    const hono = new Hono<AppEnv>();
    hono.use("*", async (c, next) => {
      c.set("user", { id: "user-1", email: "u@example.com" } as never);
      c.set("db", m.db as never);
      await next();
    });
    hono.route("/", slack);
    return hono;
  }

  const install = {
    id: "inst-1",
    workspace_id: "ws-1",
    team_id: "T1",
    team_name: "Acme",
    bot_user_id: "UBOT",
    agent_id: null,
    installed_by: "user-1",
    created_at: "2026-10-01T00:00:00Z",
  };

  it("says which scopes an install from before 0112 would need a reconnect for", async () => {
    const res = await signedIn({ ...install, scopes: null }).request("/slack", {}, ENV as never);
    const body = (await res.json()) as { installation: { missingScopes: string[] } };
    expect(body.installation.missingScopes.sort()).toEqual([
      "channels:history",
      "groups:history",
      "reactions:read",
    ]);

    const fresh = await signedIn({
      ...install,
      scopes: ["channels:history", "groups:history", "reactions:read"],
    }).request("/slack", {}, ENV as never);
    expect(
      ((await fresh.json()) as { installation: { missingScopes: string[] } }).installation
        .missingScopes,
    ).toEqual([]);
  });

  it("marks the team's routines stopped when Slack is disconnected", async () => {
    const res = await signedIn({ ...install, scopes: null }).request(
      "/slack/installation",
      { method: "DELETE" },
      ENV as never,
    );
    expect(res.status).toBe(200);
    expect(lapseSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      { provider: "slack", externalId: "T1" },
      "Slack was disconnected.",
      expect.objectContaining({ announce: expect.any(Function) }),
    );
  });
});
