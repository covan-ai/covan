import { Hono } from "hono";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
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
const getToolkit = vi.fn();
const listToolkits = vi.fn();
const listToolkitCategories = vi.fn();
const listToolkitTools = vi.fn();
vi.mock("../lib/composio/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/composio/client")>();
  return {
    ...actual,
    createLink: (...args: unknown[]) => createLink(...args),
    getConnectedAccount: (...args: unknown[]) => getConnectedAccount(...args),
    getToolkit: (...args: unknown[]) => getToolkit(...args),
    listToolkits: (...args: unknown[]) => listToolkits(...args),
    listToolkitCategories: (...args: unknown[]) => listToolkitCategories(...args),
    listToolkitTools: (...args: unknown[]) => listToolkitTools(...args),
  };
});

const { composio, composioPublic } = await import("./composio");

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
  getToolkit.mockClear();
  getToolkit.mockResolvedValue({
    kind: "ok",
    toolkit: {
      slug: "gmail",
      name: "Gmail",
      description: "Mail",
      authSchemes: ["OAUTH2"],
      managedAuth: true,
      noAuth: false,
      logo: "https://logos.composio.dev/api/gmail",
      categories: ["productivity"],
    },
  });
  listToolkits.mockClear();
  createLink.mockResolvedValue({
    kind: "ok",
    redirectUrl: "https://consent.composio.dev/x",
    connectedAccountId: "ca_1",
  });
  getConnectedAccount.mockResolvedValue({ kind: "ok", status: "active" });
  listToolkitTools.mockReset();
  listToolkitTools.mockResolvedValue({
    kind: "ok",
    total: 1,
    more: false,
    tools: [
      {
        slug: "GMAIL_SEND_EMAIL",
        name: "Send email",
        description: "Send an email.",
        toolkit: "gmail",
        required: [],
        inputSchema: null,
        destructive: null,
      },
    ],
  });
  listToolkits.mockResolvedValue({
    kind: "ok",
    nextCursor: "",
    toolkits: [
      {
        slug: "gmail",
        name: "Gmail",
        description: "Mail",
        authSchemes: ["OAUTH2"],
        managedAuth: true,
        noAuth: false,
        logo: "https://logos.composio.dev/api/gmail",
        categories: ["productivity"],
      },
    ],
  });
  listToolkitCategories.mockClear();
  listToolkitCategories.mockResolvedValue({
    kind: "ok",
    categories: [{ id: "productivity", name: "Productivity" }],
  });
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

  it("asks the catalogue whether this needs a sign-in, rather than the browser", async () => {
    // The flag decides which kind of auth config gets made. Taken from the
    // request body it would be a request choosing, so it is read here even
    // though the page that sent the request already knew the answer.
    getToolkit.mockResolvedValueOnce({
      kind: "ok",
      toolkit: { slug: "hackernews", name: "Hacker News", noAuth: true, logo: "" },
    });
    await call(appWith(), "POST", "/composio/connect", {
      toolkit: "hackernews",
      // A lie, and it must not survive.
      noAuth: false,
    });
    expect((createLink.mock.calls[0][1] as { noAuth: boolean }).noAuth).toBe(true);
  });

  it("writes the mark the catalogue published onto the row", async () => {
    // A connected application is one row out of fifteen hundred. Finding its
    // logo again later would mean searching for it; guessing it from the slug
    // would mean occasionally showing another company's mark.
    await call(appWith(), "POST", "/composio/connect", { toolkit: "gmail" });
    expect(inserted?.config).toEqual({ logo: "https://logos.composio.dev/api/gmail" });
  });

  it("leaves config empty when the catalogue published no usable mark", async () => {
    getToolkit.mockResolvedValueOnce({
      kind: "ok",
      toolkit: { slug: "gmail", name: "Gmail", noAuth: false, logo: "" },
    });
    await call(appWith(), "POST", "/composio/connect", { toolkit: "gmail" });
    expect(inserted?.config).toEqual({});
  });

  it("creates nothing anywhere when the catalogue cannot describe the application", async () => {
    getToolkit.mockResolvedValueOnce({ kind: "error", status: 404, message: "no such thing" });
    const { status } = await call(appWith(), "POST", "/composio/connect", { toolkit: "nope" });
    expect(status).toBe(502);
    expect(createLink).not.toHaveBeenCalled();
    expect(inserted).toBeNull();
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

describe("GET /composio/toolkits/:slug", () => {
  it("says it is unconfigured rather than erroring, the same as the listing", async () => {
    const res = await appWith().request(
      "/composio/toolkits/gmail",
      {},
      { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      toolkit: null,
      operations: null,
      total: null,
      more: false,
    });
  });

  it("describes the application and its first operations", async () => {
    const { status, body } = await call(appWith(), "GET", "/composio/toolkits/gmail");
    expect(status).toBe(200);
    expect(body.toolkit).toMatchObject({ slug: "gmail", name: "Gmail" });
    expect(body.operations[0]).toEqual({
      slug: "GMAIL_SEND_EMAIL",
      name: "Send email",
      description: "Send an email.",
      destructive: null,
    });
  });

  it("hands the page a path on this API rather than Composio's CDN", async () => {
    // The same assertion the listing carries, because this is the second route
    // that could leak the upstream host and nothing else would notice.
    const { body } = await call(appWith(), "GET", "/composio/toolkits/gmail");
    expect(body.toolkit.logoPath).toBe(
      "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
    expect(body.toolkit).not.toHaveProperty("logo");
    expect(JSON.stringify(body)).not.toContain("logos.composio.dev/api/gmail");
  });

  it("refuses a malformed slug before it touches the network", async () => {
    const { status } = await call(appWith(), "GET", "/composio/toolkits/NOT%20A%20SLUG");
    expect(status).toBe(400);
    expect(getToolkit).not.toHaveBeenCalled();
  });

  it("answers 404 for an application Composio does not know, not 502", async () => {
    // The card has to tell "we have never heard of this" from "Composio is
    // down", because only one of the two is worth retrying. `POST
    // /composio/connect` flattens both to 502; this one may not.
    getToolkit.mockResolvedValue({ kind: "error", status: 404, message: "no such toolkit" });
    const { status } = await call(appWith(), "GET", "/composio/toolkits/nope");
    expect(status).toBe(404);
  });

  it("still answers when the operations could not be read, so Connect survives", async () => {
    // Nobody should be stopped from connecting Gmail because a catalogue read
    // wobbled. `null` says "not read" — distinct from `[]`, which says "read,
    // and there are none".
    listToolkitTools.mockResolvedValue({ kind: "error", status: 502, message: "upstream" });
    const { status, body } = await call(appWith(), "GET", "/composio/toolkits/gmail");
    expect(status).toBe(200);
    expect(body.toolkit).toMatchObject({ slug: "gmail" });
    expect(body.operations).toBeNull();
    expect(body.total).toBeNull();
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
    expect(await res.json()).toEqual({ configured: false, toolkits: [], nextCursor: "" });
  });

  it("proxies the catalogue, so the browser never sees the key", async () => {
    const { status, body } = await call(appWith(), "GET", "/composio/toolkits?search=gm");
    expect(status).toBe(200);
    expect(body.toolkits[0]).toMatchObject({ slug: "gmail", name: "Gmail" });
    expect(JSON.stringify(body)).not.toContain("ck_test");
  });

  it("hands the page a path on this API rather than Composio's CDN", async () => {
    // The whole point of the proxy: a grid of forty tiles must not tell a
    // third party who is looking at the Integrations page.
    const { body } = await call(appWith(), "GET", "/composio/toolkits");
    expect(body.toolkits[0].logoPath).toBe(
      "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
    expect(body.toolkits[0]).not.toHaveProperty("logo");
    expect(JSON.stringify(body.toolkits)).not.toContain("logos.composio.dev/api/gmail");
  });

  it("carries the filter and the page token through to the catalogue", async () => {
    await call(appWith(), "GET", "/composio/toolkits?search=gm&category=crm&cursor=abc");
    expect(listToolkits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ search: "gm", category: "crm", cursor: "abc" }),
    );
  });

  it("leaves a toolkit with no usable logo without one, rather than guessing", async () => {
    listToolkits.mockResolvedValueOnce({
      kind: "ok",
      nextCursor: "",
      toolkits: [{ slug: "obscure", name: "Obscure", logo: "" }],
    });
    const { body } = await call(appWith(), "GET", "/composio/toolkits");
    expect(body.toolkits[0].logoPath).toBe("");
  });
});

describe("GET /composio/categories", () => {
  it("says it is unconfigured rather than erroring, like the toolkits route", async () => {
    const res = await appWith().request(
      "/composio/categories",
      {},
      { ALLOWED_ORIGIN: ENV.ALLOWED_ORIGIN },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, categories: [] });
  });

  it("answers the catalogue's own headings", async () => {
    const { status, body } = await call(appWith(), "GET", "/composio/categories");
    expect(status).toBe(200);
    expect(body.categories).toEqual([{ id: "productivity", name: "Productivity" }]);
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

/**
 * The one unauthenticated route in this file, and the only place in the
 * product where an address out of a query string decides what a Covan server
 * fetches. Every test here is about that sentence.
 */
describe("GET /composio/logo", () => {
  function publicApp() {
    const app = new Hono<AppEnv>();
    app.route("/", composioPublic);
    return app;
  }

  const png = new Uint8Array([137, 80, 78, 71]);

  function upstream(init: { status?: number; type?: string; body?: BodyInit; length?: string }) {
    return vi.fn(async () => {
      const headers = new Headers();
      if (init.type) headers.set("content-type", init.type);
      if (init.length) headers.set("content-length", init.length);
      return new Response(init.status === 200 || !init.status ? (init.body ?? png) : null, {
        status: init.status ?? 200,
        headers,
      });
    });
  }

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("serves a logo from an allowed host, cached hard", async () => {
    const fetchImpl = upstream({ type: "image/png" });
    globalThis.fetch = fetchImpl as never;

    const res = await publicApp().request(
      "/composio/logo?u=" + encodeURIComponent("https://logos.composio.dev/api/gmail"),
      {},
      ENV,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // An SVG typed into the address bar is a document on this API's origin.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://logos.composio.dev/api/gmail",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("refuses a host nobody allowlisted, without opening a socket", async () => {
    const fetchImpl = upstream({ type: "image/png" });
    globalThis.fetch = fetchImpl as never;

    for (const address of [
      "https://evil.example.com/logo.png",
      "https://logos.composio.dev.evil.example.com/x.png",
      "http://logos.composio.dev/api/gmail",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const res = await publicApp().request(
        "/composio/logo?u=" + encodeURIComponent(address),
        {},
        ENV,
      );
      expect(res.status, address).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when `u` is missing entirely", async () => {
    const res = await publicApp().request("/composio/logo", {}, ENV);
    expect(res.status).toBe(400);
  });

  it("turns Composio's own bad answers into no logo, so the tile falls back", async () => {
    // Composio has a documented set of toolkits whose logo URL 404s. A broken
    // image is worse than a monogram, so the page must never be handed one.
    for (const init of [
      { status: 404 },
      { status: 200, type: "text/html" },
      { status: 500, type: "image/png" },
    ]) {
      globalThis.fetch = upstream(init) as never;
      const res = await publicApp().request(
        "/composio/logo?u=" + encodeURIComponent("https://logos.composio.dev/api/x"),
        {},
        ENV,
      );
      expect(res.status, JSON.stringify(init)).toBe(404);
    }
  });

  it("refuses an image that claims to be larger than the ceiling", async () => {
    globalThis.fetch = upstream({ type: "image/png", length: String(2 * 1024 * 1024) }) as never;
    const res = await publicApp().request(
      "/composio/logo?u=" + encodeURIComponent("https://logos.composio.dev/api/big"),
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 rather than throwing when the CDN is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as never;
    const res = await publicApp().request(
      "/composio/logo?u=" + encodeURIComponent("https://logos.composio.dev/api/gmail"),
      {},
      ENV,
    );
    expect(res.status).toBe(404);
  });
});
