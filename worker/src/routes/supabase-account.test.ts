import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret, encryptSecret } from "../lib/secret-box";

/**
 * Connecting a Supabase account, which is the whole of what it takes to let an
 * agent query a project: paste a token, tick a project.
 *
 * Three claims here are worth more than the rest. The token is encrypted by
 * this route before Postgres sees it (0061 grants no INSERT to anybody). It is
 * checked against Supabase before it is stored, so a typo fails in front of
 * the person who made it rather than inside an agent's turn three days later.
 * And the permission question is asked BEFORE the token is sent anywhere —
 * a member who may not connect an account must not have their token handed to
 * a third party on the way to being told no.
 */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const { supabaseAccount } = await import("./supabase-account");

const USER = { id: "user-1", email: "a@example.com" };
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.example.com",
  WORKER_HOST: "api.example.com",
};

const TOKEN = "sbp_abcdefghij1234ab12";
/** What the stored envelope looks like, so the route can read a token back. */
const CIPHERTEXT = await encryptSecret(
  JSON.stringify({ headers: { Authorization: `Bearer ${TOKEN}` } }),
  KEY,
);

const ACCOUNT = {
  id: "acct-1",
  workspace_id: "ws-1",
  token_hint: "sbp…ab12",
  connected_by: USER.id,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
};

const PROJECTS = [
  { ref: "abcdefghijklmnop", name: "covan-prod", region: "eu-central-1", status: "ACTIVE_HEALTHY" },
  {
    ref: "qrstuvwxyzabcdef",
    name: "covan-staging",
    region: "eu-central-1",
    status: "ACTIVE_HEALTHY",
  },
];

/** What the service client was asked to write. */
let storedAccount: Record<string, unknown> | null = null;
let storedConnections: Array<Record<string, unknown>> = [];

function appWith(spec: { role?: string; account?: Record<string, unknown> | null } = {}) {
  const dbSpec: FakeDbSpec = {
    tables: {
      profiles: { select: () => ({ data: { active_workspace_id: "ws-1" }, error: null }) },
      workspace_members: {
        select: () => ({
          data: { workspace_id: "ws-1", role: spec.role ?? "admin" },
          error: null,
        }),
      },
      supabase_accounts: {
        select: () => ({
          data: spec.account === undefined ? ACCOUNT : spec.account,
          error: null,
        }),
        delete: () => ({ data: null, error: null }),
      },
    },
  };
  const { db } = fakeDb(dbSpec);
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", supabaseAccount);
  return app;
}

async function send(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    ENV as never,
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

beforeEach(() => {
  storedAccount = null;
  storedConnections = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify(PROJECTS), { status: 200 }));
  serviceFrom.mockReset();
  serviceFrom.mockImplementation((table: string) => {
    if (table === "supabase_accounts") {
      return {
        upsert: (values: Record<string, unknown>) => {
          storedAccount = values;
          return {
            select: () => ({
              single: async () => ({ data: { ...ACCOUNT, ...values }, error: null }),
            }),
          };
        },
        // The ciphertext column, which no client role may select and which the
        // route reads back to ask Supabase what this account can see.
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { token_ciphertext: CIPHERTEXT }, error: null }),
          }),
        }),
      };
    }
    return {
      insert: (values: Array<Record<string, unknown>>) => {
        storedConnections = values;
        return {
          select: async () => ({
            data: values.map((v, i) => ({
              ...v,
              id: `conn-${i}`,
              auth_kind: "static_header",
              created_at: "2026-09-20T10:00:00Z",
              updated_at: "2026-09-20T10:00:00Z",
            })),
            error: null,
          }),
        };
      },
    };
  });
});

describe("POST /supabase-account", () => {
  it("checks the token with Supabase, stores it encrypted, and answers with the projects", async () => {
    const res = await send(appWith({ account: null }), "POST", "/supabase-account", {
      token: TOKEN,
    });

    expect(res.status).toBe(201);
    expect(res.body?.projects).toEqual(PROJECTS);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.supabase.com/v1/projects");

    const ciphertext = String(storedAccount?.token_ciphertext ?? "");
    expect(JSON.parse(await decryptSecret(ciphertext, KEY))).toEqual({
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("never answers with the token, only with four characters of it", async () => {
    const res = await send(appWith({ account: null }), "POST", "/supabase-account", {
      token: TOKEN,
    });

    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect((res.body?.account as { tokenHint?: string })?.tokenHint).toBe("sbp…ab12");
  });

  it("stores nothing when Supabase rejects the token", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 }));

    const res = await send(appWith({ account: null }), "POST", "/supabase-account", {
      token: "sbp_wrong",
    });

    expect(res.status).toBe(400);
    expect(storedAccount).toBeNull();
  });

  it("refuses a member before the token leaves the building", async () => {
    const res = await send(
      appWith({ role: "member", account: null }),
      "POST",
      "/supabase-account",
      {
        token: TOKEN,
      },
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedAccount).toBeNull();
  });
});

describe("POST /supabase-account/projects", () => {
  it("opens a connection per project, borrowing the account's token", async () => {
    const res = await send(appWith(), "POST", "/supabase-account/projects", {
      refs: ["abcdefghijklmnop"],
    });

    expect(res.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0]).toMatchObject({
      workspace_id: "ws-1",
      transport: "supabase",
      base_url: "https://api.supabase.com",
      account_id: "acct-1",
      secret_ciphertext: null,
      label: "covan-prod",
    });
    expect((storedConnections[0].config as { ref: string }).ref).toBe("abcdefghijklmnop");
  });

  it("refuses a ref the account cannot see", async () => {
    const res = await send(appWith(), "POST", "/supabase-account/projects", {
      refs: ["not-a-project-of-yours"],
    });

    expect(res.status).toBe(400);
    expect(storedConnections).toEqual([]);
  });

  it("refuses a viewer", async () => {
    const res = await send(appWith({ role: "viewer" }), "POST", "/supabase-account/projects", {
      refs: ["abcdefghijklmnop"],
    });

    expect(res.status).toBe(403);
    expect(storedConnections).toEqual([]);
  });

  it("says so when no account is connected yet", async () => {
    const res = await send(appWith({ account: null }), "POST", "/supabase-account/projects", {
      refs: ["abcdefghijklmnop"],
    });

    expect(res.status).toBe(400);
    expect(storedConnections).toEqual([]);
  });
});

describe("GET /supabase-account", () => {
  it("reports the hint and nothing that could be a token", async () => {
    const res = await send(appWith(), "GET", "/supabase-account");

    expect(res.status).toBe(200);
    expect(res.body?.account).toMatchObject({ id: "acct-1", tokenHint: "sbp…ab12" });
    expect(JSON.stringify(res.body)).not.toContain("ciphertext");
  });

  it("answers with null when nothing is connected", async () => {
    const res = await send(appWith({ account: null }), "GET", "/supabase-account");

    expect(res.status).toBe(200);
    expect(res.body?.account).toBeNull();
  });
});

describe("DELETE /supabase-account", () => {
  it("removes it through the caller's own client, where the policy decides", async () => {
    const res = await send(appWith(), "DELETE", "/supabase-account");

    expect(res.status).toBe(204);
  });
});
