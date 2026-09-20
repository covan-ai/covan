import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";

/**
 * The two halves of §6a that are route code: replacing a grant in place, and
 * recording that somebody accepted a removal.
 *
 * Both used to be impossible. Reconnecting meant deleting the connection and
 * connecting again, which produced a SECOND row pointed at the same bundle and
 * left the first sitting there paused; and a connection paused because the
 * source had gone quiet had no way to be told "yes, really".
 */

/** Everything here writes through the service role — the row holds a secret. */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

const { fakeProvider } = vi.hoisted(() => ({
  fakeProvider: {
    id: "google_drive",
    label: "Google Drive",
    isConfigured: vi.fn(() => true),
    authorizeUrl: vi.fn(
      (_env: unknown, state: string) => `https://consent.example/?state=${state}`,
    ),
    exchangeCode: vi.fn(),
    refresh: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
  },
}));
vi.mock("../lib/connections/registry", () => ({
  providerFor: (id: string) => (id === "unknown" ? null : fakeProvider),
  providerAvailability: () => [],
}));

const { connections, connectionsPublic } = await import("./connections");
const { signState } = await import("../lib/connections/oauth-state");

const USER = { id: "user-2", email: "bob@example.com" };
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.example.com",
  WORKER_HOST: "api.example.com",
};

const CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  bundle_id: "bundle-1",
  user_id: "user-1",
  provider: "google_drive",
  account_label: "alice@example.com",
  config: { folderId: "folder-1", folderName: "Handbook" },
  status: "paused",
  paused_code: "grant_revoked",
  sync_interval_minutes: 360,
  consecutive_failures: 3,
};

beforeEach(() => {
  serviceFrom.mockReset();
  fakeProvider.isConfigured.mockReturnValue(true);
  fakeProvider.exchangeCode.mockResolvedValue({
    accountLabel: "bob@example.com",
    config: {},
    token: { accessToken: "new-token" },
  });
});

/** Records every write the service role makes, by table. */
function serviceDb(rows: Record<string, unknown> = {}) {
  const calls: Array<{ table: string; op: string; values?: Record<string, unknown> }> = [];
  serviceFrom.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    const terminal = (op: string, values?: Record<string, unknown>) => {
      calls.push({ table, op, values });
      const answer = {
        eq: () => answer,
        select: () => answer,
        single: async () => ({ data: { id: "conn-new" }, error: null }),
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      };
      return answer;
    };
    chain.select = () => terminal("select");
    chain.insert = (values: Record<string, unknown>) => terminal("insert", values);
    chain.update = (values: Record<string, unknown>) => terminal("update", values);
    return chain;
  });
  return calls;
}

function appWith(spec: FakeDbSpec = {}) {
  const fake = fakeDb(spec);
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", connections);
  app.route("/", connectionsPublic);

  const request = async (method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      },
      ENV as never,
    );

  return { request, fake };
}

/** A caller's client that finds the connection and lets the policy through. */
function callerTables(over: Partial<typeof CONNECTION> = {}) {
  return {
    connections: {
      select: () => ({ data: { ...CONNECTION, ...over }, error: null }),
      // A row coming back IS the policy saying yes; see the route.
      update: () => ({ data: { id: "conn-1" }, error: null }),
    },
  };
}

describe("POST /connections/:id/reconnect", () => {
  it("asks the database for permission before starting a flow", async () => {
    const { request, fake } = appWith({
      tables: {
        connections: {
          select: () => ({ data: CONNECTION, error: null }),
          // No row back: the policy refused. A viewer, or a member who is not
          // the grant holder on a connection that still has one.
          update: () => ({ data: null, error: null }),
        },
      },
    });

    const res = await request("POST", "/connections/conn-1/reconnect");

    expect(res.status).toBe(403);
    // And it asked by writing, rather than by re-deriving the rule here.
    expect(fake.callsTo("connections").some((c) => c.op === "update")).toBe(true);
  });

  it("carries the connection into the state, so the callback updates it", async () => {
    const { request } = appWith({ tables: callerTables() });

    const res = await request("POST", "/connections/conn-1/reconnect");
    const { url } = (await res.json()) as { url: string };

    const state = new URL(url).searchParams.get("state")!;
    const payload = JSON.parse(
      await decryptSecret(state.replace(/-/g, "+").replace(/_/g, "/"), KEY),
    );
    expect(payload).toMatchObject({
      provider: "google_drive",
      // The person doing the reconnecting, not the one who set it up.
      userId: "user-2",
      workspaceId: "ws-1",
      connectionId: "conn-1",
    });
  });

  it("refuses when the deployment no longer offers the provider", async () => {
    fakeProvider.isConfigured.mockReturnValue(false);
    const { request } = appWith({ tables: callerTables() });

    expect((await request("POST", "/connections/conn-1/reconnect")).status).toBe(501);
  });
});

describe("the callback, completing a reconnect", () => {
  const callbackFor = async (connectionId?: string) => {
    const state = await signState(
      {
        provider: "google_drive",
        userId: USER.id,
        workspaceId: "ws-1",
        bundleId: "bundle-1",
        ...(connectionId ? { connectionId } : {}),
      },
      KEY,
    );
    return `/connections/callback?code=abc&state=${state}`;
  };

  /** Membership and bundle checks the callback makes before writing anything. */
  const preflight = {
    workspace_members: { role: "member" },
    knowledge_bundles: { id: "bundle-1" },
  };

  it("replaces the grant on the row instead of adding a second connection", async () => {
    const calls = serviceDb({ ...preflight, connections: CONNECTION });
    const { request } = appWith();

    const res = await request("GET", await callbackFor("conn-1"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("reconnected=google_drive");

    // The bug this closes: an insert here leaves two rows for one Drive folder,
    // the old one paused, and nothing saying which matters.
    expect(calls.filter((c) => c.table === "connections" && c.op === "insert")).toEqual([]);

    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    // Whoever just granted access is whose view the sync now has and whose
    // allowance it now spends.
    expect(update.values).toMatchObject({
      user_id: "user-2",
      account_label: "bob@example.com",
      status: "active",
      paused_reason: null,
      paused_code: null,
      consecutive_failures: 0,
    });
    expect(
      JSON.parse(await decryptSecret(update.values!.secret_ciphertext as string, KEY)),
    ).toEqual({ accessToken: "new-token" });
  });

  it("keeps the folder that was already chosen", async () => {
    const calls = serviceDb({ ...preflight, connections: CONNECTION });
    const { request } = appWith();

    await request("GET", await callbackFor("conn-1"));

    // Replacing a credential is not setting the connection up again, and asking
    // somebody to find the same folder twice is asking for the same intention
    // twice. A folder the new grant cannot see shows up as a narrowing instead.
    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    expect(update.values?.config).toMatchObject({ folderId: "folder-1" });
    expect(update.values?.status).toBe("active");
  });

  it("does not carry an old removal approval across a new grant", async () => {
    const calls = serviceDb({ ...preflight, connections: CONNECTION });
    const { request } = appWith();

    await request("GET", await callbackFor("conn-1"));

    // A reconnect is the single most likely cause of a narrowing, so the next
    // run has to be free to notice one.
    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    expect(update.values?.removals_approved_at).toBeNull();
  });

  it("writes nothing when the connection has gone, or moved workspace", async () => {
    const calls = serviceDb({ ...preflight, connections: null });
    const { request } = appWith();

    const res = await request("GET", await callbackFor("conn-1"));

    expect(res.headers.get("location")).toContain("connection_gone");
    expect(calls.filter((c) => c.table === "connections" && c.op !== "select")).toEqual([]);
  });

  it("refuses a grant for a different provider than the row's", async () => {
    const calls = serviceDb({ ...preflight, connections: { ...CONNECTION, provider: "notion" } });
    const { request } = appWith();

    const res = await request("GET", await callbackFor("conn-1"));

    // Should be impossible: the provider is fixed at creation and the state
    // named this row. The safe answer to something impossible is to refuse.
    expect(res.headers.get("location")).toContain("wrong_provider");
    expect(calls.filter((c) => c.table === "connections" && c.op === "update")).toEqual([]);
  });

  it("still inserts when the flow was a plain connect", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith();

    const res = await request("GET", await callbackFor());

    expect(res.headers.get("location")).toContain("connected=google_drive");
    const insert = calls.find((c) => c.table === "connections" && c.op === "insert")!;
    // A Drive connection has no folder yet and must not sync until it has one.
    expect(insert.values).toMatchObject({ status: "paused", paused_code: "needs_folder" });
  });
});

describe("PATCH /connections/:id, resuming", () => {
  it("records that somebody accepted the removal", async () => {
    const calls = serviceDb({ connections: { ...CONNECTION, status: "active" } });
    const { request } = appWith({
      tables: callerTables({ paused_code: "access_narrowed" }),
    });

    await request("PATCH", "/connections/conn-1", { status: "active" });

    // Without this the pause is a trap: the run pauses, a person resumes, the
    // next run counts the same documents and pauses again, forever.
    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    expect(update.values?.removals_approved_at).toEqual(expect.any(String));
  });

  it("records nothing of the sort when resuming any other pause", async () => {
    const calls = serviceDb({ connections: { ...CONNECTION, status: "active" } });
    const { request } = appWith({ tables: callerTables({ paused_code: "repeated_failures" }) });

    await request("PATCH", "/connections/conn-1", { status: "active" });

    // Resuming after a fixed feed is not permission to delete most of a bundle.
    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    expect(update.values?.removals_approved_at).toBeUndefined();
  });

  it("clears the engine's explanation through the service role, not the caller", async () => {
    const calls = serviceDb({ connections: { ...CONNECTION, status: "active" } });
    const { request, fake } = appWith({ tables: callerTables() });

    await request("PATCH", "/connections/conn-1", { status: "active" });

    // 0057 revoked `update (paused_reason)` from `authenticated`, because that
    // grant let any member who can write put an arbitrary sentence in a column
    // the interface prints.
    const callerWrite = fake.callsTo("connections").find((c) => c.op === "update");
    expect(callerWrite?.values).not.toHaveProperty("paused_reason");
    const update = calls.find((c) => c.table === "connections" && c.op === "update")!;
    expect(update.values).toMatchObject({ paused_reason: null, paused_code: null });
  });
});
