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

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

function appWith(
  spec: {
    role?: string;
    connection?: Record<string, unknown> | null;
    onSelect?: (columns?: string) => void;
    onDelete?: () => void;
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
        update: () => ({ data: { ...ROW, label: "Renamed" }, error: null }),
        delete: () => {
          spec.onDelete?.();
          return { data: null, error: null };
        },
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
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  serviceFrom.mockReset();
  serviceFrom.mockImplementation(() => ({
    insert: (row: Record<string, unknown>) => {
      inserted = row;
      return { select: () => ({ single: async () => ({ data: ROW, error: null }) }) };
    },
    // The one column no client role may select, read here after the caller's
    // own client has already decided they may have the row (0062).
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

  /**
   * The integrations page groups connected Supabase projects under the account
   * that opened them, and it does that by `accountId`. A listing that selected
   * every other column would show an account with no projects under it and no
   * error anywhere.
   */
  it("asks for the account a project borrows its token from", async () => {
    // Asserted on the select rather than on the answer: PostgREST returns the
    // columns it was asked for, and a fake that answers whatever the spec
    // holds cannot tell a missing column from a present one. The select string
    // IS the contract here.
    let asked = "";
    const app = appWith({
      onSelect: (columns) => {
        asked = columns ?? "";
      },
    });
    await app.request("/tool-connections", {}, ENV as never);
    expect(asked).toContain("account_id");
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
    expect(String(body?.error)).toContain("already exists");
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
  it("gives the grant back before the row goes, and in that order", async () => {
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
    // Revoking after the delete would be revoking an id nothing can look up
    // any more; revoking before the permission check would let anybody who can
    // name an id hand back somebody else's grant.
    expect(order).toEqual(["revoked", "deleted"]);
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
