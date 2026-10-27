import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";

/**
 * Connecting a service, which is the whole of what it takes to give an agent
 * a new one — no code, one row.
 *
 * Two claims here are worth more than the rest. The credential is encrypted
 * by this route before Postgres sees it, which is why the row goes through
 * the service client at all (0059 grants no INSERT to anybody). And the base
 * URL goes through the same SSRF guard as every other outbound address in
 * this codebase, at creation time, so somebody pointing a connection at
 * `169.254.169.254` is told while they are still looking at the form.
 */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

// Routines listening through a removed connection (0109). Its own behaviour is
// `lifecycle.test.ts`'s; here, only when it is asked and in what order.
const lapseSubscriptions = vi.fn(async (..._args: unknown[]) => [] as string[]);
vi.mock("../lib/routines/events/lifecycle", () => ({ lapseSubscriptions }));
vi.mock("../lib/routines/dispatcher", () => ({ announceLapsedSubscription: vi.fn() }));

const { toolConnections } = await import("./tool-connections");

const USER = { id: "user-1", email: "a@example.com" };
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.example.com",
  WORKER_HOST: "api.example.com",
};

/**
 * The same deployment with Composio turned on.
 *
 * Only the delete tests use it: adding the key to `ENV` would change what
 * `toolAvailability` reports in the listing above, which is a different claim
 * and not one this block is making.
 */
const COMPOSIO_ENV = { ...ENV, COMPOSIO_API_KEY: "ck_test" };

const ROW = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Covan Supabase",
  transport: "sql",
  base_url: "https://proj.supabase.co/rest/v1",
  auth_kind: "static_header",
  allowed_methods: ["GET"],
  config: { rpc: "covan_query" },
  created_by: USER.id,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
};

/** What `serviceFrom` records about the insert it was given. */
let inserted: Record<string, unknown> | null = null;
/** What the caller's own client was asked to UPDATE. */
let updated: Record<string, unknown> | null = null;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

function appWith(
  spec: {
    role?: string;
    connection?: Record<string, unknown> | null;
    onSelect?: (columns?: string) => void;
    onDelete?: () => void;
    deleteAllowed?: boolean;
    /** What the caller's own client answers for `tool_connection_grants`. */
    grants?: NonNullable<FakeDbSpec["tables"]>[string];
  } = {},
) {
  const dbSpec: FakeDbSpec = {
    tables: {
      profiles: { select: () => ({ data: { active_workspace_id: "ws-1" }, error: null }) },
      workspace_members: {
        select: () => ({
          data: { workspace_id: "ws-1", role: spec.role ?? "admin" },
          error: null,
        }),
      },
      tool_connections: {
        select: (ctx) => {
          spec.onSelect?.(ctx.columns);
          return {
            data: spec.connection === undefined ? [ROW] : spec.connection,
            error: null,
          };
        },
        update: (ctx: { values?: unknown }) => {
          updated = (ctx.values ?? null) as Record<string, unknown> | null;
          return { data: { ...ROW, label: "Renamed" }, error: null };
        },
        delete: () => {
          spec.onDelete?.();
          // A row coming back IS `tool_connections_delete` saying yes, and an
          // empty result is the policy refusing. The two can disagree with the
          // read above, which `tool_connections_read` grants to any member.
          return {
            data: spec.deleteAllowed === false ? [] : [{ id: "conn-1" }],
            error: null,
          };
        },
      },
      ...(spec.grants ? { tool_connection_grants: spec.grants } : {}),
    },
  };
  const { db } = fakeDb(dbSpec);
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", toolConnections);
  return app;
}

async function post(app: Hono<AppEnv>, body: Record<string, unknown>) {
  const res = await app.request(
    "/tool-connections",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV as never,
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as { error?: unknown } | null,
  };
}

const VALID = {
  label: "Covan Supabase",
  transport: "sql",
  baseUrl: "https://proj.supabase.co/rest/v1",
  headers: { Authorization: "Bearer key", apikey: "key" },
  rpc: "covan_query",
};

beforeEach(() => {
  inserted = null;
  updated = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  serviceFrom.mockReset();
  serviceFrom.mockImplementation(() => ({
    insert: (row: Record<string, unknown>) => {
      inserted = row;
      return { select: () => ({ single: async () => ({ data: ROW, error: null }) }) };
    },
    // The one column no client role may select, read here after the caller's
    // own client has already decided they may have the row (0063).
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { connected_account_id: "ca_1" }, error: null }),
      }),
    }),
  }));
});

describe("GET /tool-connections", () => {
  it("lists the services and what this build can do with them", async () => {
    const res = await appWith().request("/tool-connections", {}, ENV as never);
    const body = (await res.json()) as {
      connections: Array<{ id: string; rpc: string | null }>;
      tools: Array<{ name: string; configured: boolean }>;
    };
    expect(body.connections[0]).toMatchObject({ id: "conn-1", rpc: "covan_query" });
    // Every tool, configured or not — a self-hoster reading the docs for a
    // feature their build appears not to have is what that list prevents.
    expect(body.tools.map((t) => t.name)).toContain("query_database");
  });

  it("never names the credential column, which PostgREST would refuse whole", async () => {
    const res = await appWith().request("/tool-connections", {}, ENV as never);
    const body = (await res.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections[0]).not.toHaveProperty("secret_ciphertext");
  });
});

describe("POST /tool-connections", () => {
  it("encrypts the headers before the row is written", async () => {
    const { status } = await post(appWith(), VALID);
    expect(status).toBe(201);
    const ciphertext = inserted?.secret_ciphertext as string;
    // The envelope format, not a plaintext token sitting in a column.
    expect(ciphertext.startsWith("v1.")).toBe(true);
    expect(JSON.parse(await decryptSecret(ciphertext, KEY))).toEqual({
      headers: { Authorization: "Bearer key", apikey: "key" },
    });
  });

  it("defaults a SQL connection to the documented function name", async () => {
    await post(appWith(), { ...VALID, rpc: undefined });
    expect(inserted?.config).toEqual({ rpc: "covan_query" });
  });

  it("defaults an HTTP connection to GET alone", async () => {
    await post(appWith(), {
      label: "Orders",
      transport: "http",
      baseUrl: "https://orders.example.net",
      headers: { Authorization: "Bearer k" },
    });
    expect(inserted?.allowed_methods).toEqual(["GET"]);
  });

  it("strips a trailing slash once, so base + path is one rule everywhere after", async () => {
    await post(appWith(), { ...VALID, baseUrl: "https://proj.supabase.co/rest/v1/" });
    expect(inserted?.base_url).toBe("https://proj.supabase.co/rest/v1");
  });

  it("refuses an address in private space while somebody is still looking at the form", async () => {
    const { status, body } = await post(appWith(), {
      ...VALID,
      baseUrl: "http://169.254.169.254/latest/meta-data",
    });
    expect(status).toBe(400);
    expect(String(body?.error)).toContain("private address");
    expect(inserted).toBeNull();
  });

  it("refuses to be pointed back at this deployment", async () => {
    const { status } = await post(appWith(), { ...VALID, baseUrl: "https://api.example.com/x" });
    expect(status).toBe(400);
    expect(inserted).toBeNull();
  });

  it("refuses a viewer, who reads and does not decide what agents can reach", async () => {
    const { status } = await post(appWith({ role: "viewer" }), VALID);
    expect(status).toBe(403);
    expect(inserted).toBeNull();
  });

  it("refuses a credential with no headers in it", async () => {
    const { status } = await post(appWith(), { ...VALID, headers: {} });
    expect(status).toBe(201);
    // An empty object is valid JSON and a useless credential; the schema
    // accepts it and the tool says so at call time. What must not happen is
    // a row with no ciphertext at all.
    expect(inserted?.secret_ciphertext).toBeTruthy();
  });

  it("says so rather than writing a row this deployment cannot decrypt", async () => {
    const res = await appWith().request(
      "/tool-connections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID),
      },
      { ALLOWED_ORIGIN: "https://app.example.com" } as never,
    );
    expect(res.status).toBe(501);
    expect(inserted).toBeNull();
  });

  it("turns a duplicate name into a sentence rather than a 500", async () => {
    serviceFrom.mockImplementation(() => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: null, error: { code: "23505" } }) }),
      }),
    }));
    const { status, body } = await post(appWith(), VALID);
    expect(status).toBe(400);
    // Personal by default (0098), so the name it clashes with is the caller's own.
    expect(String(body?.error)).toContain("you already have a connection with that name");
  });

  it("makes a connection personal unless asked to share it", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    serviceFrom.mockImplementation(() => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: { ...row, id: "c1", created_at: "2026-10-13T00:00:00Z" },
              error: null,
            }),
          }),
        };
      },
    }));

    const personal = await post(appWith(), VALID);
    const shared = await post(appWith(), { ...VALID, label: "Team API", shared: true });

    expect(inserted.map((r) => r.scope)).toEqual(["owner", "workspace"]);
    expect(personal.body).toMatchObject({ scope: "owner", mine: true });
    expect(shared.body).toMatchObject({ scope: "workspace", mine: true });
  });
});

describe("PATCH /tool-connections/:id", () => {
  it("goes through the caller's own client, so the policy decides", async () => {
    const res = await appWith({ connection: ROW }).request(
      "/tool-connections/conn-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
      ENV as never,
    );
    expect(res.status).toBe(200);
    // Nothing reached the service client, which is the claim: editing is a
    // question RLS already answers.
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("shares a connection, or takes it back, through the same client", async () => {
    const res = await appWith({ connection: ROW }).request(
      "/tool-connections/conn-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared: true }),
      },
      ENV as never,
    );
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ scope: "workspace" });
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("forgets that a summary was ever machine-written when a person replaces it", async () => {
    // `describe_connection` decides whether a cached summary is stale by
    // looking for `summary_cached_at`. Left behind under a person's own text,
    // the next rendering change would treat their words as an old rendering
    // and write a generated table listing over them.
    const res = await appWith({
      connection: {
        ...ROW,
        config: {
          rpc: "covan_query",
          summary: "old listing",
          summary_cached_at: "2026-09-01T00:00:00Z",
          summary_version: 2,
        },
      },
    }).request(
      "/tool-connections/conn-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Our reporting warehouse." }),
      },
      ENV as never,
    );
    expect(res.status).toBe(200);
    const config = (updated?.config ?? {}) as Record<string, unknown>;
    expect(config.summary).toBe("Our reporting warehouse.");
    expect(config.summary_cached_at).toBeUndefined();
    expect(config.summary_version).toBeUndefined();
  });

  it("is a 404 for a connection the caller cannot see", async () => {
    const res = await appWith({ connection: null }).request(
      "/tool-connections/conn-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
      ENV as never,
    );
    expect(res.status).toBe(404);
  });
});

/**
 * Removing a connection, and the thing that is only true of one kind of them.
 *
 * When Covan holds the credential, deleting the row deletes it. When Composio
 * holds it, deleting the row deletes nothing: the OAuth grant stays live at the
 * provider, attached to an account id no screen in this product can show any
 * more. So this is the one deletion path in the codebase that has to make a
 * request before it deletes — and it is deliberately the ONLY one, rather than
 * a second endpoint beside it, because a second road out would be a second
 * place to forget.
 */
describe("DELETE /tool-connections/:id", () => {
  it("gives the grant back only once the database has agreed to the delete", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push("revoked");
      return new Response(null, { status: 204 });
    });

    const app = appWith({
      connection: { id: "conn-1", workspace_id: "ws-1", transport: "composio" },
      onDelete: () => order.push("deleted"),
    });
    const res = await app.request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );

    expect(res.status).toBe(204);
    // Revoking first would hand back somebody else's grant on the word of a
    // read that admits more people than the delete does, so the delete — which
    // IS the permission question — goes first and the irreversible step last.
    // What still has to happen before the delete is the service-role read of
    // the account id, because the delete takes that id with it; the test below
    // on a refused caller is what proves no revocation rides along with it.
    expect(order).toEqual(["deleted", "revoked"]);
  });

  it("tells the routines listening through it before the grant is given back", async () => {
    const order: string[] = [];
    lapseSubscriptions.mockImplementationOnce(async () => {
      order.push("lapsed");
      return [];
    });
    fetchMock.mockImplementation(async () => {
      order.push("revoked");
      return new Response(null, { status: 204 });
    });
    const app = appWith({
      connection: { id: "conn-1", workspace_id: "ws-1", transport: "composio", label: "gmail" },
      onDelete: () => order.push("deleted"),
    });
    const res = await app.request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );

    expect(res.status).toBe(204);
    // Ending a trigger at Composio needs the account it was made on, so the
    // lapse comes before the revocation — and after the delete, which is the
    // permission question.
    expect(order).toEqual(["deleted", "lapsed", "revoked"]);
    expect(lapseSubscriptions.mock.calls[0][1]).toEqual({ config: { connectionId: "conn-1" } });
    expect(lapseSubscriptions.mock.calls[0][2]).toBe("gmail was disconnected.");
  });

  it("revokes nothing when the delete policy refuses the caller", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push("revoked");
      return new Response(null, { status: 204 });
    });

    const app = appWith({
      role: "member",
      connection: { id: "conn-1", workspace_id: "ws-1", transport: "composio" },
      // `tool_connections_read` admits any member (0059:138); the delete admits
      // only the creator or an admin (0059:158). This is a member who is
      // neither, which the read cannot tell apart.
      deleteAllowed: false,
    });
    const res = await app.request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );

    expect(res.status).toBe(403);
    // The revocation is irreversible and happens at Composio. Doing it on a
    // delete the database then refuses hands back somebody else's grant and
    // leaves the row behind, still listed, pointing at a dead account.
    expect(order).toEqual([]);
  });

  it("removes the row anyway when Composio refuses the revocation", async () => {
    // A row a person cannot remove is the worse failure: the alternative is an
    // integrations page with a card that will not go away. The refusal is
    // logged loudly instead — see `lib/composio/revoke.ts`.
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const app = appWith({
      connection: { id: "conn-1", workspace_id: "ws-1", transport: "composio" },
    });
    const res = await app.request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );
    expect(res.status).toBe(204);
  });

  it("is a 404 for a connection the caller cannot see", async () => {
    const res = await appWith({ connection: null }).request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );
    expect(res.status).toBe(404);
  });

  it("makes no request at all for a connection that keeps its own credential", async () => {
    const app = appWith({ connection: ROW });
    const res = await app.request(
      "/tool-connections/conn-1",
      { method: "DELETE" },
      COMPOSIO_ENV as never,
    );
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * "Don't ask again for this app": one row per agent and connection (0140).
 * Every read and write goes through the caller's own client, so the policies
 * decide who may — these only check the route says what they decided.
 */
describe("/tool-connection-grants", () => {
  const AGENT = "11111111-1111-4111-8111-111111111111";
  const CONN = "22222222-2222-4222-8222-222222222222";
  const SAVED = {
    agent_id: AGENT,
    tool_connection_id: CONN,
    granted_by: USER.id,
    granted_at: "2026-10-27T10:00:00Z",
  };

  async function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
    const res = await app.request(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      ENV as never,
    );
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  beforeEach(() => serviceFrom.mockClear());

  it("lets an agent change things in an app, through the caller's own client", async () => {
    let values: Record<string, unknown> | null = null;
    const app = appWith({
      grants: {
        insert: (ctx) => {
          values = ctx.values as Record<string, unknown>;
          return { data: SAVED, error: null };
        },
      },
    });
    const { status, body } = await send(app, "PUT", "/tool-connection-grants", {
      agentId: AGENT,
      connectionId: CONN,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ agentId: AGENT, connectionId: CONN, grantedBy: USER.id });
    expect(values).toEqual({ agent_id: AGENT, tool_connection_id: CONN, workspace_id: "ws-1" });
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("says who may grant when the policy refuses", async () => {
    const app = appWith({
      grants: {
        insert: () => ({ data: null, error: { message: "denied", code: "42501" } }),
      },
    });
    const { status, body } = await send(app, "PUT", "/tool-connection-grants", {
      agentId: AGENT,
      connectionId: CONN,
    });
    expect(status).toBe(403);
    expect(String(body?.error)).toMatch(/only the person who connected it/);
  });

  it("answers a permission that is already there as saved", async () => {
    const app = appWith({
      grants: {
        insert: () => ({ data: null, error: { message: "duplicate", code: "23505" } }),
        select: () => ({ data: SAVED, error: null }),
      },
    });
    const { status, body } = await send(app, "PUT", "/tool-connection-grants", {
      agentId: AGENT,
      connectionId: CONN,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ agentId: AGENT, connectionId: CONN });
  });

  it("refuses a body without both ids", async () => {
    const { status } = await send(appWith(), "PUT", "/tool-connection-grants", {
      agentId: AGENT,
    });
    expect(status).toBe(400);
  });

  it("lists an agent's permissions", async () => {
    const app = appWith({ grants: { select: () => ({ data: [SAVED], error: null }) } });
    const { status, body } = await send(app, "GET", `/tool-connection-grants?agentId=${AGENT}`);
    expect(status).toBe(200);
    expect(body?.grants).toEqual([
      { agentId: AGENT, connectionId: CONN, grantedBy: USER.id, grantedAt: expect.any(Number) },
    ]);
  });

  it("takes a permission away", async () => {
    let deleted = false;
    const app = appWith({
      grants: {
        delete: () => {
          deleted = true;
          return { data: [{ agent_id: AGENT }], error: null };
        },
      },
    });
    const { status } = await send(
      app,
      "DELETE",
      `/tool-connection-grants?agentId=${AGENT}&connectionId=${CONN}`,
    );
    expect(status).toBe(204);
    expect(deleted).toBe(true);
  });

  it("says so when the policy matched nothing, rather than reporting it removed", async () => {
    // RLS refuses a delete by matching no row: somebody without edit access to
    // the agent, or a permission that is not there.
    const app = appWith({ grants: { delete: () => ({ data: [], error: null }) } });
    const { status } = await send(
      app,
      "DELETE",
      `/tool-connection-grants?agentId=${AGENT}&connectionId=${CONN}`,
    );
    expect(status).toBe(403);
  });

  it("refuses a delete that does not name both", async () => {
    const { status } = await send(appWith(), "DELETE", `/tool-connection-grants?agentId=${AGENT}`);
    expect(status).toBe(400);
  });
});
