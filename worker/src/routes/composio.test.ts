import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";

/**
 * Connecting one of about fifteen hundred applications.
 *
 * Three claims here carry the file. The permission question is asked BEFORE
 * anything is created at a third party, so a refused caller leaves no
 * half-finished consent flow behind them. The row the insert writes never
 * carries an identifier the caller chose — both the account reference and the
 * per-connection user id come from this route. And the status poll settles the
 * row once and then stops asking.
 */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

const createLink = vi.fn();
const getConnectedAccount = vi.fn();
const listToolkits = vi.fn();
vi.mock("../lib/composio/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/composio/client")>();
  return {
    ...actual,
    createLink: (...args: unknown[]) => createLink(...args),
    getConnectedAccount: (...args: unknown[]) => getConnectedAccount(...args),
    listToolkits: (...args: unknown[]) => listToolkits(...args),
  };
});

const { composio } = await import("./composio");

const USER = { id: "user-1", email: "a@example.com" };
const ENV = { ALLOWED_ORIGIN: "https://app.example.com", COMPOSIO_API_KEY: "ck_test" };

const ROW = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Gmail",
  transport: "composio",
  base_url: "https://backend.composio.dev",
  auth_kind: "composio",
  allowed_methods: ["GET"],
  config: {},
  account_id: null,
  toolkit_slug: "gmail",
  status: "pending",
  // Never selectable by a client (0063). It is here because the service-role
  // read in the status route is what fills it in, and a fixture without it
  // would make that route look like it had lost the account.
  connected_account_id: "ca_1",
  composio_user_id: "cu_1",
  created_by: USER.id,
  created_at: "2026-09-24T10:00:00Z",
  updated_at: "2026-09-24T10:00:00Z",
};

/** What the service client was asked to write, per table. */
let inserted: Record<string, unknown> | null = null;
let updated: Record<string, unknown> | null = null;

function appWith(spec: { role?: string; row?: Record<string, unknown> | null } = {}) {
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
        select: () => ({ data: spec.row === undefined ? ROW : spec.row, error: null }),
      },
      tool_connection_grants: {
        select: () => ({ data: [], error: null }),
        // An upsert lands on the insert handler, which is what PostgREST makes
        // of one — see `fakeDb`.
        insert: (ctx) => {
          const values = ctx.values as Record<string, unknown>;
          return {
            data: {
              agent_id: values.agent_id,
              tool_connection_id: values.tool_connection_id,
              slug: values.slug,
              mode: values.mode,
              granted_by: USER.id,
              granted_at: "2026-09-24T10:00:00Z",
            },
            error: null,
          };
        },
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
  app.route("/", composio);
  return app;
}

/** The service-role client, answering the insert and the settle-the-status update. */
function serviceTables(row: Record<string, unknown> = ROW) {
  return () => {
    const link = {
      insert: (values: Record<string, unknown>) => {
        inserted = values;
        return link;
      },
      update: (values: Record<string, unknown>) => {
        updated = values;
        return link;
      },
      select: () => link,
      eq: () => link,
      maybeSingle: async () => ({ data: row, error: null }),
      single: async () => ({ data: { ...row, ...(inserted ?? {}) }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: row, error: null }).then(resolve),
    };
    return link;
  };
}

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const res = await app.request(
    path,
    {
      method,
      ...(body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    },
    ENV,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  inserted = null;
  updated = null;
  serviceFrom.mockReset();
  serviceFrom.mockImplementation(serviceTables());
  // Cleared as well as re-stubbed: `mockResolvedValue` replaces the
  // implementation and keeps the call history, and two of these tests assert
  // that a call did NOT happen.
  createLink.mockClear();
  getConnectedAccount.mockClear();
  listToolkits.mockClear();
  createLink.mockResolvedValue({
    kind: "ok",
    redirectUrl: "https://consent.composio.dev/x",
    connectedAccountId: "ca_1",
  });
  getConnectedAccount.mockResolvedValue({ kind: "ok", status: "active" });
  listToolkits.mockResolvedValue({ kind: "ok", toolkits: [{ slug: "gmail", name: "Gmail" }] });
});

describe("POST /composio/connect", () => {
  it("refuses a viewer before anything exists at Composio", async () => {
    // The order is the security of this route. A person who may not connect a
    // service must be told no without a consent flow having been created in
    // their name and abandoned.
    const { status } = await call(appWith({ role: "viewer" }), "POST", "/composio/connect", {
      toolkit: "gmail",
    });
    expect(status).toBe(403);
    expect(createLink).not.toHaveBeenCalled();
  });

  it("answers 501 rather than half-working without a key", async () => {
    const res = await appWith().request(
      "/composio/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: "gmail" }),
      },
      { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN },
    );
    expect(res.status).toBe(501);
    expect(createLink).not.toHaveBeenCalled();
  });

  it("writes both identifiers itself, and neither comes from the caller", async () => {
    const { status, body } = await call(appWith(), "POST", "/composio/connect", {
      toolkit: "gmail",
      // Not fields the schema accepts. If either were ever honoured, a member
      // could point their row at another workspace's grant.
      connectedAccountId: "ca_somebody_else",
      composioUserId: "cu_somebody_else",
    });

    expect(status).toBe(201);
    expect(body.url).toBe("https://consent.composio.dev/x");
    expect(inserted?.connected_account_id).toBe("ca_1");
    expect(inserted?.composio_user_id).not.toBe("cu_somebody_else");
    // A uuid this route minted, not a Covan account id: shipping one of those
    // to a third party as a durable identifier is a thing this codebase does
    // not do.
    expect(String(inserted?.composio_user_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted?.composio_user_id).not.toBe(USER.id);
  });

  it("starts the row pending, so nothing half-made reaches an agent", async () => {
    await call(appWith(), "POST", "/composio/connect", { toolkit: "gmail" });
    expect(inserted?.status).toBe("pending");
    expect(inserted?.transport).toBe("composio");
    expect(inserted?.toolkit_slug).toBe("gmail");
    // `listConnections` filters on status, so this row is invisible to the
    // model until the consent screen is finished.
    expect(inserted?.secret_ciphertext).toBeNull();
    expect(inserted?.account_id).toBeNull();
  });

  it("sends the person back to the integrations page afterwards", async () => {
    await call(appWith(), "POST", "/composio/connect", { toolkit: "gmail" });
    const link = createLink.mock.calls[0][1] as { callbackUrl: string };
    expect(link.callbackUrl).toBe("https://app.example.com/integrations?connected=gmail");
  });
});

describe("GET /composio/connections/:id/status", () => {
  it("settles a pending row once and says so", async () => {
    const { status, body } = await call(appWith(), "GET", "/composio/connections/conn-1/status");
    expect(status).toBe(200);
    expect(body.status).toBe("active");
    expect(updated).toEqual({ status: "active" });
  });

  it("does not ask Composio again about a row that is already settled", async () => {
    const { body } = await call(
      appWith({ row: { ...ROW, status: "active" } }),
      "GET",
      "/composio/connections/conn-1/status",
    );
    expect(body.status).toBe("active");
    expect(getConnectedAccount).not.toHaveBeenCalled();
  });

  it("refuses a connection that is not an application", async () => {
    const { status } = await call(
      appWith({ row: { ...ROW, transport: "sql" } }),
      "GET",
      "/composio/connections/conn-1/status",
    );
    expect(status).toBe(400);
  });
});

describe("GET /composio/toolkits", () => {
  it("says it is unconfigured rather than erroring, so the page can name the variable", async () => {
    const res = await appWith().request(
      "/composio/toolkits",
      {},
      {
        ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, toolkits: [] });
  });

  it("proxies the catalogue, so the browser never sees the key", async () => {
    const { status, body } = await call(appWith(), "GET", "/composio/toolkits?search=gm");
    expect(status).toBe(200);
    expect(body.toolkits).toEqual([{ slug: "gmail", name: "Gmail" }]);
    expect(JSON.stringify(body)).not.toContain("ck_test");
  });
});

describe("grants", () => {
  it("goes through the caller's own client, so the policies decide", async () => {
    const { status, body } = await call(appWith({ role: "member" }), "PUT", "/composio/grants", {
      agentId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      slug: "GMAIL_SEND_EMAIL",
      mode: "ask",
    });
    expect(status).toBe(200);
    expect(body.mode).toBe("ask");
    // Nothing on this path touches the service role: 0063's WITH CHECK is what
    // refuses an `always` from somebody who is not an admin, and re-asking that
    // question here would be a second permission system.
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("refuses a delete that does not name the whole key", async () => {
    const { status } = await call(appWith(), "DELETE", "/composio/grants?agentId=a");
    expect(status).toBe(400);
  });
});
