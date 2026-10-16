import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { decryptSecret, encryptSecret } from "../lib/secret-box";

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
  // A row whose provider is Notion resolves to a provider whose id says so, so
  // a grant for one provider cannot land on a row of another.
  providerFor: (id: string) =>
    id === "unknown" ? null : id === "notion" ? { ...fakeProvider, id: "notion" } : fakeProvider,
  providerAvailability: () => [],
}));

/** Drive itself, which one of the tests below is about never reaching. */
const { listFolders } = vi.hoisted(() => ({ listFolders: vi.fn() }));
vi.mock("../lib/connections/google-drive", () => ({ listFolders }));

/** The routines listening through a connection, which removing it lapses. */
const { lapseSubscriptions } = vi.hoisted(() => ({
  lapseSubscriptions: vi.fn(async (..._args: unknown[]) => [] as string[]),
}));
vi.mock("../lib/routines/events/lifecycle", () => ({ lapseSubscriptions }));
vi.mock("../lib/routines/dispatcher", () => ({ announceLapsedSubscription: vi.fn() }));

const { connections, connectionsPublic } = await import("./connections");
const { signState, sealGrant, readState, nonceHashOf } =
  await import("../lib/connections/oauth-state");

/** What the starting tab keeps in session storage, and the hash it sent. */
const NONCE = "nonce-of-the-starting-tab-0123456789";
const NONCE_HASH = await nonceHashOf(NONCE);

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
  listFolders.mockReset();
  listFolders.mockResolvedValue([{ id: "folder-2", name: "Policies" }]);
  fakeProvider.isConfigured.mockReturnValue(true);
  fakeProvider.refresh.mockResolvedValue({ accessToken: "stored-token" });
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

    const res = await request("POST", "/connections/conn-1/reconnect", { nonceHash: NONCE_HASH });

    expect(res.status).toBe(403);
    // And it asked by writing, rather than by re-deriving the rule here.
    expect(fake.callsTo("connections").some((c) => c.op === "update")).toBe(true);
  });

  it("carries the connection into the state, so the callback updates it", async () => {
    const { request } = appWith({ tables: callerTables() });

    const res = await request("POST", "/connections/conn-1/reconnect", { nonceHash: NONCE_HASH });
    const { url } = (await res.json()) as { url: string };

    const state = new URL(url).searchParams.get("state")!;
    const payload = JSON.parse(
      await decryptSecret(state.replace(/-/g, "+").replace(/_/g, "/"), KEY, "covan/oauth-state/v2"),
    );
    expect(payload).toMatchObject({
      provider: "google_drive",
      // The person doing the reconnecting, not the one who set it up.
      userId: "user-2",
      workspaceId: "ws-1",
      connectionId: "conn-1",
      // And the starting tab's nonce, by hash: completing asks for the nonce.
      nonceHash: NONCE_HASH,
    });
  });

  it("refuses when the deployment no longer offers the provider", async () => {
    fakeProvider.isConfigured.mockReturnValue(false);
    const { request } = appWith({ tables: callerTables() });

    expect(
      (await request("POST", "/connections/conn-1/reconnect", { nonceHash: NONCE_HASH })).status,
    ).toBe(501);
  });
});

describe("the callback", () => {
  it("seals the code for the app instead of exchanging it", async () => {
    // The browser coming back from a consent screen carries no Covan session,
    // so the callback cannot know whose it is. Exchanging here is what let a
    // consent link sent to somebody else plant their Drive in the starter's
    // workspace.
    const calls = serviceDb();
    const { request } = appWith();
    const state = await signState(
      {
        provider: "google_drive",
        userId: USER.id,
        workspaceId: "ws-1",
        bundleId: "bundle-1",
        nonceHash: NONCE_HASH,
      },
      KEY,
    );

    const res = await request("GET", `/connections/callback?code=abc&state=${state}`);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/integrations");
    expect(location.searchParams.get("for")).toBe("connection");
    expect(location.searchParams.get("grant")).toBeTruthy();
    expect(fakeProvider.exchangeCode).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("turns a state it did not issue away on the spot", async () => {
    const { request } = appWith();
    const res = await request("GET", "/connections/callback?code=abc&state=forged");
    expect(res.headers.get("location")).toContain("error=expired");
  });
});

describe("POST /connections/complete", () => {
  /** A grant as the callback seals one, for a flow started by `userId`. */
  const grantFor = async (over: { connectionId?: string; userId?: string } = {}) => {
    const raw = await signState(
      {
        provider: "google_drive",
        userId: over.userId ?? USER.id,
        workspaceId: "ws-1",
        bundleId: "bundle-1",
        nonceHash: NONCE_HASH,
        ...(over.connectionId ? { connectionId: over.connectionId } : {}),
      },
      KEY,
    );
    const state = (await readState(raw, KEY))!;
    return sealGrant(
      { state, code: "abc", redirectUri: "https://api.example.com/connections/callback" },
      KEY,
    );
  };

  /** Membership and bundle checks made before anything is exchanged. */
  const preflight = {
    workspace_members: { role: "member" },
    knowledge_bundles: { id: "bundle-1" },
  };

  it("refuses a grant somebody else started, before exchanging anything", async () => {
    // The planting case: an attacker starts a flow and sends the consent link
    // to the person reading this. Their browser comes back with the grant;
    // completing it as themselves must store nothing of theirs anywhere.
    const calls = serviceDb(preflight);
    const { request } = appWith();

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor({ userId: "user-attacker" }),
      nonce: NONCE,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_yours" });
    expect(fakeProvider.exchangeCode).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("refuses without the nonce of the tab that started the flow", async () => {
    const { request } = appWith();
    const res = await request("POST", "/connections/complete", {
      grant: await grantFor(),
      nonce: "a-different-tab-nonce-0123456789",
    });
    expect(res.status).toBe(403);
    expect(fakeProvider.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a grant it did not seal", async () => {
    const { request } = appWith();
    const state = await signState(
      {
        provider: "google_drive",
        userId: USER.id,
        workspaceId: "ws-1",
        bundleId: "bundle-1",
        nonceHash: NONCE_HASH,
      },
      KEY,
    );
    // A state is not a grant, though one key seals both.
    const res = await request("POST", "/connections/complete", { grant: state, nonce: NONCE });
    expect(res.status).toBe(400);
  });

  it("exchanges with the redirect the code was issued against", async () => {
    serviceDb(preflight);
    const { request } = appWith();
    await request("POST", "/connections/complete", { grant: await grantFor(), nonce: NONCE });
    expect(fakeProvider.exchangeCode).toHaveBeenCalledWith(
      expect.anything(),
      "abc",
      "https://api.example.com/connections/callback",
      expect.anything(),
    );
  });

  it("inserts a new connection for a plain connect", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith();

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor(),
      nonce: NONCE,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "google_drive", reconnected: false });
    const insert = calls.find((c) => c.table === "connections" && c.op === "insert")!;
    // A Drive connection has no folder yet and must not sync until it has one.
    expect(insert.values).toMatchObject({ status: "paused", paused_code: "needs_folder" });
  });

  it("replaces the grant on the row instead of adding a second connection", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith({ tables: callerTables() });

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor({ connectionId: "conn-1" }),
      nonce: NONCE,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reconnected: true, connectionId: "conn-1" });
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
      // A reconnect is the single most likely cause of a narrowing, so an old
      // approval must not carry across it.
      removals_approved_at: null,
    });
    // Replacing a credential is not setting the connection up again.
    expect(update.values?.config).toMatchObject({ folderId: "folder-1" });
    expect(
      JSON.parse(await decryptSecret(update.values!.secret_ciphertext as string, KEY)),
    ).toEqual({ accessToken: "new-token" });
  });

  it("asks again whether the caller may still change the connection", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith({
      tables: {
        connections: {
          select: () => ({ data: CONNECTION, error: null }),
          // The policy no longer lets this caller change the row.
          update: () => ({ data: null, error: null }),
        },
      },
    });

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor({ connectionId: "conn-1" }),
      nonce: NONCE,
    });

    expect(res.status).toBe(403);
    expect(fakeProvider.exchangeCode).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.table === "connections" && c.op === "update")).toEqual([]);
  });

  it("writes nothing when the connection has gone", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith({
      tables: { connections: { select: () => ({ data: null, error: null }) } },
    });

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor({ connectionId: "conn-1" }),
      nonce: NONCE,
    });

    expect(await res.json()).toEqual({ error: "connection_gone" });
    expect(calls.filter((c) => c.table === "connections" && c.op !== "select")).toEqual([]);
  });

  it("refuses a grant for a different provider than the row's", async () => {
    const calls = serviceDb(preflight);
    const { request } = appWith({ tables: callerTables({ provider: "notion" }) });

    const res = await request("POST", "/connections/complete", {
      grant: await grantFor({ connectionId: "conn-1" }),
      nonce: NONCE,
    });

    expect(await res.json()).toEqual({ error: "wrong_provider" });
    expect(calls.filter((c) => c.table === "connections" && c.op === "update")).toEqual([]);
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

describe("GET /connections/:id/folders", () => {
  /** The stored grant, as `tokenFor` expects to find it. */
  const storedGrant = async () => ({
    connections: {
      secret_ciphertext: await encryptSecret(JSON.stringify({ accessToken: "stored-token" }), KEY),
    },
  });

  it("refuses a caller the policy would not let change the connection", async () => {
    serviceDb(await storedGrant());
    const { request } = appWith({
      tables: {
        connections: {
          select: () => ({ data: CONNECTION, error: null }),
          // No row back: the policy refused. A viewer, or a member who is not
          // the grant holder on a connection that still has one.
          update: () => ({ data: null, error: null }),
        },
      },
    });

    const res = await request("GET", "/connections/conn-1/folders");

    expect(res.status).toBe(403);
    // The whole of the finding: this route decrypts somebody else's Drive
    // token and lists whatever `?parent` names, so a refusal that arrives
    // after the listing is not a refusal.
    expect(listFolders).not.toHaveBeenCalled();
  });

  it("lists folders for the grant holder, and asks the database first", async () => {
    serviceDb({ ...(await storedGrant()), workspace_members: { user_id: USER.id } });
    const { request, fake } = appWith({ tables: callerTables({ user_id: USER.id }) });

    const res = await request("GET", "/connections/conn-1/folders");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "folder-2", name: "Policies" }]);
    expect(fake.callsTo("connections").some((c) => c.op === "update")).toBe(true);
  });

  // The probe writes `status` back to itself. Unconditional, it wrote the value
  // read a moment before, so a sync that paused the connection in between was
  // un-paused by somebody opening its folder list.
  it("probes only where the status is still what it read, so it undoes nothing", async () => {
    serviceDb({ ...(await storedGrant()), workspace_members: { user_id: USER.id } });
    const { request, fake } = appWith({ tables: callerTables({ user_id: USER.id }) });

    await request("GET", "/connections/conn-1/folders");

    const probe = fake.callsTo("connections").find((c) => c.op === "update");
    expect(probe?.values).toEqual({ status: "paused" });
    expect(probe?.filters).toContainEqual({ column: "status", value: "paused", kind: "eq" });
  });

  // The policy lets an admin change a member's connection, and used to let
  // anybody who could write change one whose holder had closed their account.
  // Neither is a reason to read the holder's Drive with their token.
  it.each([
    ["an admin who is not the holder", "user-1"],
    ["a writer, once the holder has closed their account", null],
  ])("refuses %s, before any token is used", async (_label, holder) => {
    serviceDb(await storedGrant());
    const { request } = appWith({ tables: callerTables({ user_id: holder as never }) });

    const res = await request("GET", "/connections/conn-1/folders");

    expect(res.status).toBe(403);
    expect(listFolders).not.toHaveBeenCalled();
  });

  it("refuses the holder's own token once they have left the workspace", async () => {
    // The caller is the holder by id, but has no seat here any more: the
    // check `tokenFor` shares with the sync engine stops the token being used.
    serviceDb({ ...(await storedGrant()), workspace_members: null });
    const { request } = appWith({ tables: callerTables({ user_id: USER.id }) });

    const res = await request("GET", "/connections/conn-1/folders");

    expect(res.status).toBe(502);
    expect(listFolders).not.toHaveBeenCalled();
  });
});

describe("choosing a Drive folder", () => {
  it("is the grant holder's alone", async () => {
    // An admin may pause a member's connection. Pointing it at the member's
    // private folder is reading their Drive with their token.
    const calls = serviceDb();
    const { request } = appWith({ tables: callerTables({ user_id: "user-1" }) });

    const res = await request("PATCH", "/connections/conn-1", { folderId: "private" });

    expect(res.status).toBe(403);
    expect(calls.some((c) => c.table === "connections" && c.op === "update")).toBe(false);
  });
});

describe("DELETE /connections/:id", () => {
  const tables = (deleted: unknown[]) => ({
    connections: {
      select: () => ({
        data: { id: "conn-1", bundle_id: "bundle-1", account_label: "alice@example.com" },
        error: null,
      }),
      delete: () => ({ data: deleted, error: null }),
    },
  });

  // A Notion page or a Drive file can start a routine through this connection;
  // once it is gone, those routines hear nothing and their owners are told.
  it("lapses the routines listening through it, once the row is gone", async () => {
    const { request } = appWith({ tables: tables([{ id: "conn-1" }]) });

    const res = await request("DELETE", "/connections/conn-1");

    expect(res.status).toBe(200);
    expect(lapseSubscriptions).toHaveBeenCalledWith(
      expect.anything(),
      { config: { connectionId: "conn-1" } },
      "alice@example.com was disconnected.",
      expect.objectContaining({ announce: expect.any(Function) }),
    );
  });

  it("lapses nothing when the caller may not remove it", async () => {
    const { request } = appWith({ tables: tables([]) });

    expect((await request("DELETE", "/connections/conn-1")).status).toBe(403);
    expect(lapseSubscriptions).not.toHaveBeenCalled();
  });
});
