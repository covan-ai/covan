import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AppEnv } from "../types";
import {
  activeWorkspaceTables,
  fakeDb,
  type FakeDbSpec,
  type QueryContext,
} from "../test-support/fake-db";
import { browser, offerable } from "./browser";
import * as takeover from "../lib/browser/takeover";
import * as profiles from "../lib/browser/profiles";
import * as controls from "../lib/browser/controls";
import * as credentials from "../lib/browser/credentials";
import * as live from "../lib/browser/live";

/**
 * The route half of a takeover, which is the half that answers permission
 * questions. `lib/browser/takeover.ts` holds the service-role client and
 * answers to no policy, so what matters here is that nothing reaches it that
 * the caller's own client did not first agree to.
 */

const USER = { id: "user-1", email: "a@example.com" };
const WORKSPACE_ID = "workspace-1";

/** A task that failed at a login wall: the only shape a takeover is offered for. */
const FAILED_TASK = {
  id: "task-1",
  workspace_id: WORKSPACE_ID,
  status: "failed",
  output: "could not sign in to the supplier portal",
  retry_of: null,
};

/**
 * One row (or none) out of a select, in the shape `fakeDb` wants.
 *
 * Filter-aware on `retry_of`, because the route makes two reads of
 * `browser_tasks`: the task itself, and then a look for a row naming it as the
 * one it replaces. Answering the second with the task would read as "already
 * tried again" and 409 every request.
 */
function selects(row: Record<string, unknown> | null) {
  return {
    select: (ctx: QueryContext) => {
      const successorLookup = ctx.filters.some((f) => f.column === "retry_of");
      return { data: successorLookup ? null : row, error: null };
    },
  };
}

function appWith(spec: FakeDbSpec & { apiKeyId?: string; country?: string } = {}) {
  const { apiKeyId, country, ...dbSpec } = spec;
  const { db, calls, callsTo } = fakeDb({
    ...dbSpec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(dbSpec.tables ?? {}) },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
    await next();
  });
  app.route("/", browser);

  return { app, calls, callsTo, country };
}

async function json(
  fixture: ReturnType<typeof appWith>,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (fixture.country) headers["CF-IPCountry"] = fixture.country;
  const res = await fixture.app.request(
    path,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    { BROWSER_USE_API_KEY: "bu_test" } as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let open: ReturnType<typeof vi.spyOn>;
let close: ReturnType<typeof vi.spyOn>;
let session: ReturnType<typeof vi.spyOn>;
let liveUrl: ReturnType<typeof vi.spyOn>;
let held: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  open = vi.spyOn(takeover, "openTakeover").mockResolvedValue({
    kind: "ok",
    id: "to-1",
    liveUrl: "https://live.browser-use.com/abc",
    expiresAt: "2026-10-10T12:10:00.000Z",
  });
  close = vi.spyOn(takeover, "closeTakeover").mockResolvedValue({
    kind: "ok",
    retriedTaskId: "task-2",
    cookieDomains: ["portal.example.com"],
    message: "signed in and trying again",
  });
  session = vi.spyOn(takeover, "providerSessionFor").mockResolvedValue("s-1");
  // Ruling R44: nobody has a browser of their own open, which is the ordinary case.
  held = vi.spyOn(takeover, "heldTakeover").mockResolvedValue(false);
  liveUrl = vi.spyOn(profiles, "browserLiveUrl").mockResolvedValue({
    kind: "ok",
    value: {
      id: "s-1",
      status: "active",
      liveUrl: "https://live.browser-use.com/abc",
      timeoutAt: null,
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("the offerable predicate", () => {
  it("offers a failed task that said something", () => {
    expect(offerable(FAILED_TASK)).toBe(true);
  });

  it.each([
    ["a task that finished", { ...FAILED_TASK, status: "finished" }],
    // Nothing to sign into: a 404 or a MAX_POLLS give-up never reached a page.
    ["a failure with no output", { ...FAILED_TASK, output: null }],
    ["a failure with empty output", { ...FAILED_TASK, output: "" }],
    // THE bound on operator spend. Without it, a retry that fails at a second
    // wall is offerable again and the loop is free browser tasks forever.
    ["a task that is already a retry", { ...FAILED_TASK, retry_of: "task-0" }],
  ])("refuses %s", (_label, row) => {
    expect(offerable(row)).toBe(false);
  });
});

describe("POST /browser/takeovers", () => {
  it("refuses an API-key caller before reading anything", async () => {
    const fixture = appWith({ apiKeyId: "key-1", tables: { browser_tasks: selects(FAILED_TASK) } });
    const { status, body } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(403);
    expect(String(body.error)).toContain("api keys cannot");
    expect(open).not.toHaveBeenCalled();
  });

  it("hands the live URL back in the body, and writes it nowhere", async () => {
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) } });
    const { status, body } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(200);
    expect(body.liveUrl).toBe("https://live.browser-use.com/abc");
    // browser-use: "Treat the URL as a credential." It may be in this body
    // and in no row, no log and no message.
    const written = JSON.stringify(fixture.calls);
    expect(written).not.toContain("live.browser-use.com");
  });

  it("takes the workspace from the row, never from the request", async () => {
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) } });
    await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
      workspaceId: "somebody-elses-workspace",
    });

    expect(open.mock.calls[0][1]).toMatchObject({
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      browserTaskId: "task-1",
    });
  });

  it("404s a task the caller's own client cannot see", async () => {
    // RLS makes "not yours" and "no such thing" the same answer, on purpose.
    const fixture = appWith({ tables: { browser_tasks: selects(null) } });
    const { status } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });

  /**
   * The condition the predicate cannot answer, because the successor is a
   * different row. It runs BEFORE openTakeover, so the refusal costs nothing —
   * 0077's unique index would refuse the insert anyway, but by then a real
   * browser has been rented and the provider bills a minute minimum.
   */
  it("409s a task that already has a successor, before spending anything", async () => {
    let call = 0;
    const fixture = appWith({
      tables: {
        browser_tasks: {
          select: () => {
            call += 1;
            // The route reads the task, then looks for its successor.
            return call === 1
              ? { data: FAILED_TASK, error: null }
              : { data: { id: "task-2" }, error: null };
          },
        },
      },
    });
    const { status, body } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(409);
    expect(String(body.error)).toContain("already been tried again");
    expect(open).not.toHaveBeenCalled();
  });

  it("409s a task that is already a retry, rather than spending again", async () => {
    const fixture = appWith({
      tables: { browser_tasks: selects({ ...FAILED_TASK, retry_of: "task-0" }) },
    });
    const { status } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(409);
    expect(open).not.toHaveBeenCalled();
  });

  it("pins the egress to the request's own country", async () => {
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) }, country: "DE" });
    await json(fixture, "POST", "/browser/takeovers", { browserTaskId: "task-1" });

    expect(open.mock.calls[0][1]).toMatchObject({ proxyCountryCode: "de" });
  });

  /**
   * browser-use spells the United Kingdom `uk`; `CF-IPCountry` says `GB`.
   * Sent unmapped it is a 422 on every takeover from the UK — a whole country
   * unable to sign in to anything, with "could not open a browser for you" as
   * the only symptom, and nothing in a test suite that mocks the provider
   * would ever have shown it.
   */
  it("spells the United Kingdom the way the provider does", async () => {
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) }, country: "GB" });
    await json(fixture, "POST", "/browser/takeovers", { browserTaskId: "task-1" });

    expect(open.mock.calls[0][1]).toMatchObject({ proxyCountryCode: "uk" });
  });

  it.each(["XX", "T1"])("pins nothing when Cloudflare answers %s", async (code) => {
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) }, country: code });
    await json(fixture, "POST", "/browser/takeovers", { browserTaskId: "task-1" });

    // Tor and "could not tell" are not countries to bind a cookie jar to.
    expect(open.mock.calls[0][1]).toMatchObject({ proxyCountryCode: null });
  });

  it("passes the module's own refusal through with its status", async () => {
    open.mockResolvedValue({ kind: "error", status: 409, message: "you already have one open" });
    const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) } });
    const { status, body } = await json(fixture, "POST", "/browser/takeovers", {
      browserTaskId: "task-1",
    });

    expect(status).toBe(409);
    expect(body.error).toBe("you already have one open");
  });
});

describe("GET /browser/takeovers/current", () => {
  const OPEN_ROW = {
    id: "to-1",
    user_id: USER.id,
    browser_task_id: "task-1",
    status: "open",
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  /**
   * The reload case, and the likeliest day-one failure without it: the live
   * URL exists only in the body that minted it, and one open takeover is
   * allowed, so a reloaded tab would otherwise lock somebody out of their own
   * signed-in browser for the rest of the window.
   */
  it("re-reads the live URL from the provider rather than remembering it", async () => {
    const fixture = appWith({ tables: { browser_takeovers: selects(OPEN_ROW) } });
    const { status, body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(status).toBe(200);
    expect(body.takeover).toMatchObject({
      id: "to-1",
      browserTaskId: "task-1",
      liveUrl: "https://live.browser-use.com/abc",
    });
    expect(liveUrl).toHaveBeenCalledOnce();
  });

  it("answers none when there is no open row", async () => {
    const fixture = appWith({ tables: { browser_takeovers: selects(null) } });
    const { body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(body.takeover).toBeNull();
    expect(liveUrl).not.toHaveBeenCalled();
  });

  /**
   * Ruling R51 (b), `heldTakeover`'s reading: an open row is the person's
   * browser until it is closed, even past `expires_at` — the provider keeps
   * it up to fifteen minutes, and the take-over and the hand-back refuse on
   * it. So a reload gets it back, with its Done, rather than an Open browser
   * beside a refusal that says to press Done somewhere it cannot be seen.
   */
  it("answers a row past its window that is still open, inside the provider's lifetime", async () => {
    const fixture = appWith({
      tables: {
        browser_takeovers: selects({
          ...OPEN_ROW,
          created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        }),
      },
    });
    const { body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(body.takeover).toMatchObject({
      id: "to-1",
      liveUrl: "https://live.browser-use.com/abc",
    });
    // Still asked of the provider, which says whether the browser is there.
    expect(liveUrl).toHaveBeenCalledOnce();
  });

  it("answers none for a row past the provider's lifetime, asking the provider nothing", async () => {
    const fixture = appWith({
      tables: {
        browser_takeovers: selects({
          ...OPEN_ROW,
          created_at: new Date(Date.now() - 16 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      },
    });
    const { body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(body.takeover).toBeNull();
    // The provider has ended that browser; POST is what closes the row.
    expect(liveUrl).not.toHaveBeenCalled();
  });

  it("answers none when the provider says the browser is no longer active", async () => {
    liveUrl.mockResolvedValue({
      kind: "ok",
      value: { id: "s-1", status: "stopped", liveUrl: null, timeoutAt: null },
    });
    const fixture = appWith({ tables: { browser_takeovers: selects(OPEN_ROW) } });
    const { body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(body.takeover).toBeNull();
  });

  it("resolves the provider session scoped to the caller", async () => {
    const fixture = appWith({ tables: { browser_takeovers: selects(OPEN_ROW) } });
    await json(fixture, "GET", "/browser/takeovers/current");

    expect(session.mock.calls[0][1]).toEqual({ takeoverId: "to-1", userId: USER.id });
  });
});

describe("POST /browser/takeovers/:id/close", () => {
  it("refuses an API-key caller", async () => {
    const fixture = appWith({ apiKeyId: "key-1" });
    const { status } = await json(fixture, "POST", "/browser/takeovers/to-1/close");

    expect(status).toBe(403);
    expect(close).not.toHaveBeenCalled();
  });
});

/**
 * The gate is on the router, not on each handler, and this is the case that
 * made that necessary: `GET .../current` returns the same live URL `POST`
 * mints, and the static ratchet cannot tell one handler from another — it only
 * asks whether the FILE refuses a key somewhere.
 */
describe("every route refuses an API key", () => {
  it("refuses the read that hands back a live URL", async () => {
    const fixture = appWith({
      apiKeyId: "key-1",
      tables: {
        browser_takeovers: selects({
          id: "to-1",
          user_id: USER.id,
          browser_task_id: "task-1",
          status: "open",
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      },
    });
    const { status, body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(status).toBe(403);
    // The point: a key must not be able to read a credential whose access
    // outlives the key's own revocation.
    expect(JSON.stringify(body)).not.toContain("live.browser-use.com");
    expect(session).not.toHaveBeenCalled();
    expect(liveUrl).not.toHaveBeenCalled();
  });

  it("closes, and reports what the sign-in reached", async () => {
    const fixture = appWith({});
    const { status, body } = await json(fixture, "POST", "/browser/takeovers/to-1/close");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      retriedTaskId: "task-2",
      cookieDomains: ["portal.example.com"],
    });
  });

  it("passes the caller's own client and id, which is the claim's predicate", async () => {
    const fixture = appWith({});
    await json(fixture, "POST", "/browser/takeovers/to-1/close");

    expect(close.mock.calls[0][1]).toMatchObject({ takeoverId: "to-1", userId: USER.id });
    expect(close.mock.calls[0][1]).toHaveProperty("callerDb");
  });

  it("refuses a second close with the module's own status", async () => {
    close.mockResolvedValue({
      kind: "error",
      status: 409,
      message: "that takeover is already closed",
    });
    const fixture = appWith({});
    const { status, body } = await json(fixture, "POST", "/browser/takeovers/to-1/close");

    expect(status).toBe(409);
    expect(body.error).toBe("that takeover is already closed");
  });
});

/**
 * The forget control (§7a).
 *
 * The read is the caller's own client, because `cookie_domains` is a column
 * `authenticated` may select; the delete is not, because `provider_profile_id`
 * is a column no client role may even read. So what these tests pin is the
 * same split the rest of this file does: the permission question answered here,
 * the provider id handled over there.
 */
describe("the browser profile", () => {
  it("reports which sites the jar is signed into, read with the caller's own client", async () => {
    const fixture = appWith({
      tables: {
        browser_profiles: {
          select: () => ({
            data: {
              cookie_domains: ["portal.example.com", "mail.example.com"],
              created_at: "2026-10-01T00:00:00.000Z",
              last_used_at: "2026-10-08T00:00:00.000Z",
            },
            error: null,
          }),
        },
      },
    });
    const { status, body } = await json(fixture, "GET", "/browser/profile");

    expect(status).toBe(200);
    expect(body.profile).toMatchObject({
      cookieDomains: ["portal.example.com", "mail.example.com"],
    });
  });

  it("answers no profile rather than an empty one when nothing is held", async () => {
    const fixture = appWith({
      tables: { browser_profiles: { select: () => ({ data: null, error: null }) } },
    });
    const { status, body } = await json(fixture, "GET", "/browser/profile");

    expect(status).toBe(200);
    expect(body.profile).toBeNull();
  });

  /**
   * The read tells somebody which sites this person is signed into, which is
   * recon rather than work, and no API-key caller has a use for it. The delete
   * destroys sign-ins outright. Both are refused for `ACTS_BEYOND_THE_KEY`'s
   * reason, from the other direction.
   */
  it.each([
    ["GET", "/browser/profile"],
    ["DELETE", "/browser/profile"],
  ])("refuses an API-key caller on %s %s", async (method, path) => {
    const fixture = appWith({ apiKeyId: "key-1" });
    const { status } = await json(fixture, method, path);

    expect(status).toBe(403);
  });

  it("forgets the jar and names what went, through the module that holds the provider id", async () => {
    const forget = vi
      .spyOn(takeover, "forgetProfile")
      .mockResolvedValue({ kind: "ok", forgotten: ["portal.example.com"] });
    const fixture = appWith({});
    const { status, body } = await json(fixture, "DELETE", "/browser/profile");

    expect(status).toBe(200);
    expect(body).toMatchObject({ forgotten: ["portal.example.com"] });
    expect(forget.mock.calls[0][1]).toBe(USER.id);
  });

  it("answers the module's own status when a browser is still open", async () => {
    vi.spyOn(takeover, "forgetProfile").mockResolvedValue({
      kind: "error",
      status: 409,
      message: "a browser of yours is open right now",
    });
    const fixture = appWith({});
    const { status, body } = await json(fixture, "DELETE", "/browser/profile");

    expect(status).toBe(409);
    expect(body.error).toBe("a browser of yours is open right now");
  });
});

/**
 * The browser beside the conversation: watch, take over, hand back, stop.
 *
 * What these pin is the route's half — the refusal first, the row read
 * through the caller's own client (RLS deciding "not yours" as 404), and only
 * then the module that holds the service role, called with the row id and the
 * caller's own user id. `controls.test.ts` pins what the module does.
 */
describe("/browser/sessions/:id", () => {
  const SESSION = { id: "bs-1", live_state: "agent", human_since: null };
  const ORIGINAL = {
    id: "bt-0",
    workspace_id: WORKSPACE_ID,
    agent_id: "agent-1",
    user_id: USER.id,
    session_id: "chat-1",
    task: "read the pricing table",
    retry_of: null,
    // A settled `login_required`: the run completed, and the row says failed.
    status: "failed",
    stop_reason: null,
  };
  const LIVE = "https://live.browser-use.com/the-panel";

  let take: ReturnType<typeof vi.spyOn>;
  let hand: ReturnType<typeof vi.spyOn>;
  let watch: ReturnType<typeof vi.spyOn>;
  let stop: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    take = vi
      .spyOn(controls, "takeOverBrowser")
      .mockResolvedValue({ kind: "human", humanSince: 1_791_000_000_000 });
    hand = vi
      .spyOn(controls, "handBackBrowser")
      .mockResolvedValue({ kind: "ok", browserTaskId: "bt-1" });
    watch = vi
      .spyOn(controls, "liveBrowser")
      .mockResolvedValue({ kind: "ok", liveUrl: LIVE, liveState: "agent" });
    stop = vi.spyOn(controls, "stopConversationBrowser").mockResolvedValue({ kind: "ok" });
  });

  function withSession(
    row: Record<string, unknown> | null,
    tasks: Record<string, unknown> | null = ORIGINAL,
    apiKeyId?: string,
  ) {
    return appWith({
      apiKeyId,
      tables: { browser_sessions: selects(row), browser_tasks: selects(tasks) },
    });
  }

  async function call(fixture: ReturnType<typeof appWith>, method: string, path: string) {
    const res = await fixture.app.request(path, { method }, {
      BROWSER_USE_API_KEY: "bu_test",
    } as never);
    const raw = await res.text();
    return {
      status: res.status,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      headers: res.headers,
    };
  }

  const ROUTES: Array<[string, string]> = [
    ["GET", "/browser/sessions/bs-1/live"],
    ["POST", "/browser/sessions/bs-1/take-over"],
    ["POST", "/browser/sessions/bs-1/hand-back"],
    ["POST", "/browser/sessions/bs-1/stop"],
  ];

  const anyModuleCalled = () => [take, hand, watch, stop].some((spy) => spy.mock.calls.length > 0);

  it.each(ROUTES)("refuses an API key on %s %s before reading anything", async (method, path) => {
    const fixture = withSession({ ...SESSION, live_state: "human" }, ORIGINAL, "key-1");
    const { status, body } = await call(fixture, method, path);

    expect(status).toBe(403);
    expect(String(body?.error)).toContain("api keys cannot");
    expect(fixture.calls.filter((c) => c.table === "browser_sessions")).toEqual([]);
    expect(anyModuleCalled()).toBe(false);
  });

  /**
   * RLS on `browser_sessions` is the owner's: a colleague in the same shared
   * conversation sees the answers and nothing of the browser, so to them the
   * row is not there — and "not yours" is the same 404 as "no such thing".
   */
  it.each(ROUTES)(
    "404s %s %s for a browser the caller's client cannot see",
    async (method, path) => {
      const fixture = withSession(null);
      const { status } = await call(fixture, method, path);

      expect(status).toBe(404);
      expect(anyModuleCalled()).toBe(false);
    },
  );

  it.each(ROUTES)("reads %s %s's row through the caller's own client", async (method, path) => {
    const fixture = withSession({ ...SESSION, live_state: "human" });
    await call(fixture, method, path);

    const read = fixture.calls.find((c) => c.table === "browser_sessions");
    expect(read?.filters).toContainEqual({ column: "id", value: "bs-1", kind: "eq" });
  });

  describe("GET …/live", () => {
    it("hands the live URL to its owner in the body, and writes it nowhere", async () => {
      const said = vi.spyOn(console, "log").mockImplementation(() => {});
      const fixture = withSession(SESSION);
      const { status, body, headers } = await call(fixture, "GET", "/browser/sessions/bs-1/live");

      expect(status).toBe(200);
      expect(body).toEqual({ liveUrl: LIVE, liveState: "agent" });
      expect(watch.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1", userId: USER.id });
      // A credential: not for a shared cache or the browser's disk cache.
      expect(headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.stringify(fixture.calls)).not.toContain("the-panel");
      const spoken = [said, console.error as unknown as typeof said].flatMap((s) => s.mock.calls);
      expect(JSON.stringify(spoken)).not.toContain("the-panel");
    });

    it("re-mints on every call, so a reload gets the browser back", async () => {
      const fixture = withSession(SESSION);
      await call(fixture, "GET", "/browser/sessions/bs-1/live");
      const again = await call(fixture, "GET", "/browser/sessions/bs-1/live");

      expect(again.body).toMatchObject({ liveUrl: LIVE });
      expect(watch).toHaveBeenCalledTimes(2);
    });

    it("409s when no browser is live", async () => {
      watch.mockResolvedValue({ kind: "error", status: 409, message: "no browser is open" });
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "GET", "/browser/sessions/bs-1/live");

      expect(status).toBe(409);
      expect(body).toEqual({ error: "no browser is open" });
    });
  });

  describe("POST …/take-over", () => {
    it("answers human once the provider says the run has ended", async () => {
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(200);
      expect(body).toEqual({ liveState: "human", humanSince: 1_791_000_000_000 });
      expect(take.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1", userId: USER.id });
    });

    /** Review focus 2: the panel stays inert until the run is really over. */
    it("answers 202 cancelling while the run has not ended", async () => {
      take.mockResolvedValue({ kind: "cancelling" });
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(202);
      expect(body).toEqual({ liveState: "cancelling" });
    });

    it("answers a browser already in the caller's hands without touching the provider", async () => {
      const fixture = withSession({
        ...SESSION,
        live_state: "human",
        human_since: "2026-10-10T12:00:00.000Z",
      });
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(200);
      expect(body).toEqual({
        liveState: "human",
        humanSince: Date.parse("2026-10-10T12:00:00.000Z"),
      });
      expect(take).not.toHaveBeenCalled();
    });

    it("passes the module's refusal through with its status", async () => {
      take.mockResolvedValue({ kind: "error", status: 502, message: "could not stop the agent" });
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(502);
      expect(body).toEqual({ error: "could not stop the agent" });
    });

    /**
     * Ruling R46: the person's own browser is live on the jar this one runs
     * on, and whichever stops last writes it. Taking this one too would put
     * the jar in two pairs of hands, so it is refused before the provider is
     * asked anything — `takeOverBrowser` is what cancels runs and reads the
     * browser, so not calling it is both.
     */
    it("409s while the caller has a browser of their own open, before the provider is asked", async () => {
      held.mockResolvedValue(true);
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(409);
      // The panel shows the server's sentence as it is (M2): capital to period.
      expect(String(body?.error)).toMatch(/^Press Done in the browser you opened.*\.$/);
      expect(held.mock.calls[0][1]).toBe(USER.id);
      expect(take).not.toHaveBeenCalled();
      expect(fixture.calls.filter((c) => c.op !== "select")).toEqual([]);
    });

    it("500s, asking the provider nothing, when it cannot tell whether one is open", async () => {
      held.mockResolvedValue(null);
      const fixture = withSession(SESSION);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/take-over");

      expect(status).toBe(500);
      expect(body).toEqual({ error: "Couldn't check your other browser. Try again in a moment." });
      expect(take).not.toHaveBeenCalled();
    });
  });

  describe("POST …/hand-back", () => {
    const HUMAN = { ...SESSION, live_state: "human", human_since: "2026-10-10T12:00:00.000Z" };

    it("continues the newest task in this browser, read through the caller's client", async () => {
      const fixture = withSession(HUMAN);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(200);
      expect(body).toEqual({ browserTaskId: "bt-1" });
      expect(hand.mock.calls[0][1]).toEqual({
        browserSessionId: "bs-1",
        userId: USER.id,
        original: ORIGINAL,
      });
      const read = fixture.calls.find(
        (c) => c.table === "browser_tasks" && !c.filters.some((f) => f.column === "retry_of"),
      );
      expect(read?.filters).toContainEqual({
        column: "browser_session_id",
        value: "bs-1",
        kind: "eq",
      });
      expect(read?.order).toEqual([{ column: "created_at", ascending: false }]);
    });

    /** The one free retry: a second hand-back for the same task is refused before it costs. */
    it("409s an original that already has a successor, before the provider is asked", async () => {
      let call_ = 0;
      const fixture = appWith({
        tables: {
          browser_sessions: selects(HUMAN),
          browser_tasks: {
            select: () => {
              call_ += 1;
              return call_ === 1
                ? { data: ORIGINAL, error: null }
                : { data: { id: "bt-1" }, error: null };
            },
          },
        },
      });
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(String(body?.error)).toContain("already been tried again");
      expect(hand).not.toHaveBeenCalled();
    });

    it("continues a run the person took over mid-way", async () => {
      const midRun = { ...ORIGINAL, status: "stopped", stop_reason: "handed_to_person" };
      const fixture = withSession(HUMAN, midRun);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(200);
      expect(body).toEqual({ browserTaskId: "bt-1" });
      expect(hand.mock.calls[0][1]).toMatchObject({ original: { id: "bt-0" } });
    });

    /**
     * `offerable()`'s rule, which the free retry has always been bound by: a
     * task that answered has nothing to continue, and re-running it would put
     * a second answer in the conversation and spend the retry. A run stopped
     * at its cost ceiling is not offered either — continuing it would be a
     * second full ceiling of the operator's money.
     */
    it.each([
      ["a task that finished", { status: "finished", stop_reason: null }],
      ["a run stopped at its cost ceiling", { status: "stopped", stop_reason: "cost_cap" }],
    ])("409s %s, before the provider is asked or a row is written", async (_label, over) => {
      const fixture = withSession(HUMAN, { ...ORIGINAL, ...over });
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(String(body?.error)).toContain("nothing for the agent to continue");
      // `handBackBrowser` is the only thing here that calls the provider or
      // writes a row, so not calling it is both.
      expect(hand).not.toHaveBeenCalled();
      expect(fixture.calls.filter((c) => c.op !== "select")).toEqual([]);
    });

    it("409s a browser that is not in the caller's hands", async () => {
      const fixture = withSession(SESSION);
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(hand).not.toHaveBeenCalled();
    });

    it("409s when this browser has run nothing to continue", async () => {
      const fixture = withSession(HUMAN, null);
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(hand).not.toHaveBeenCalled();
    });

    it("passes the module's refusal through with its status", async () => {
      hand.mockResolvedValue({ kind: "error", status: 409, message: "already tried once" });
      const fixture = withSession(HUMAN);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(body).toEqual({ error: "already tried once" });
    });

    /**
     * Ruling R44: a browser the person opened for themselves is live on the
     * same jar. The agent's run would make two live browsers on it, and the
     * one that stops last writes it — so a fresh sign-in could be lost. Refused
     * before the provider is asked or a row written, which leaves the free
     * retry where it was.
     */
    it("409s while the caller has a browser of their own open, before the retry is spent", async () => {
      held.mockResolvedValue(true);
      const fixture = withSession(HUMAN);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(409);
      expect(String(body?.error)).toMatch(/press Done in the browser you opened/i);
      expect(held.mock.calls[0][1]).toBe(USER.id);
      expect(hand).not.toHaveBeenCalled();
      expect(fixture.calls.filter((c) => c.op !== "select")).toEqual([]);
    });

    it("500s, without spending the retry, when it cannot tell whether one is open", async () => {
      held.mockResolvedValue(null);
      const fixture = withSession(HUMAN);
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/hand-back");

      expect(status).toBe(500);
      expect(hand).not.toHaveBeenCalled();
    });
  });

  describe("POST …/stop", () => {
    /**
     * The browser's runs, as the caller's own client answers the in-flight
     * read: `runs` rows, or an error. Separate from `withSession`, whose task
     * fixture is a single row for the hand-back's reads.
     */
    function withRuns(
      row: Record<string, unknown>,
      runs: Array<Record<string, unknown>> | { error: { code: string; message: string } },
    ) {
      return appWith({
        tables: {
          browser_sessions: selects(row),
          browser_tasks: {
            select: () =>
              Array.isArray(runs) ? { data: runs, error: null } : { data: null, error: runs.error },
          },
        },
      });
    }

    it("stops the browser and answers 204", async () => {
      const fixture = withRuns({ ...SESSION, live_state: "human" }, []);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(204);
      expect(body).toBeNull();
      expect(stop.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1", userId: USER.id });
    });

    it("passes a failed stop through with its status", async () => {
      stop.mockResolvedValue({ kind: "error", status: 502, message: "could not stop it" });
      const fixture = withRuns({ ...SESSION, live_state: "none" }, []);
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(502);
    });

    /**
     * Ruling R50: Stop never kills a running agent run. A stop does not cancel
     * the run, and a run whose browser vanished under it settles as a failure
     * (R17) — so a v4 run of this browser still queued or running is refused,
     * read through the caller's own client before the provider is asked.
     */
    it("409s while a run of this browser has not settled, before anything is stopped", async () => {
      const fixture = withRuns({ ...SESSION, live_state: "none" }, [{ id: "bt-9" }]);
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(409);
      expect(body).toEqual({
        error: "The agent is using this browser right now. Take it over in the conversation first.",
      });
      expect(stop).not.toHaveBeenCalled();
      const read = fixture.calls.find((c) => c.table === "browser_tasks");
      expect(read?.filters).toEqual(
        expect.arrayContaining([
          { column: "browser_session_id", value: "bs-1", kind: "eq" },
          { column: "api_version", value: "v4", kind: "eq" },
          { column: "status", value: ["queued", "running"], kind: "in" },
        ]),
      );
    });

    it("409s while the row says the agent has it and its last run was under ten minutes ago", async () => {
      const fixture = withRuns(
        {
          ...SESSION,
          live_state: "agent",
          last_run_at: new Date(Date.now() - 9 * 60_000).toISOString(),
        },
        [],
      );
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(409);
      expect(String(body?.error)).toMatch(/^The agent is using this browser right now\./);
      expect(stop).not.toHaveBeenCalled();
    });

    /**
     * Ruling R51 (c): an `agent` row with no run is a finished run nobody has
     * settled yet — the cron may not be running. Refused for ever, it was a
     * browser with no way out from Settings, and none at all once its
     * conversation was gone. Ten minutes after its last run, with nothing in
     * flight, it is stopped like any other.
     */
    it("stops an agent row with no run in flight once its last run is over ten minutes old", async () => {
      const fixture = withRuns(
        {
          ...SESSION,
          live_state: "agent",
          last_run_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        },
        [],
      );
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(204);
      expect(stop.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1", userId: USER.id });
    });

    it("still 409s an old agent row while a run of it is in flight", async () => {
      const fixture = withRuns(
        {
          ...SESSION,
          live_state: "agent",
          last_run_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
        [{ id: "bt-9" }],
      );
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(409);
      expect(stop).not.toHaveBeenCalled();
    });

    it("500s, stopping nothing, when it cannot tell whether a run is going", async () => {
      const fixture = withRuns(
        { ...SESSION, live_state: "human" },
        { error: { code: "57014", message: "timeout" } },
      );
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(500);
      expect(stop).not.toHaveBeenCalled();
    });
  });
});

/**
 * The status is the module's, not a constant here. The cast on that line is a
 * type assertion for Hono's literal union and does nothing at runtime, which
 * is easy to misread as a clamp — so 402, the one a person can do nothing
 * about and the operator can, is pinned.
 */
it("passes a 402 through, so the operator's bill is not reported as a bug", async () => {
  open.mockResolvedValue({
    kind: "error",
    status: 402,
    message: "this deployment has run out of browser credit",
  });
  const fixture = appWith({ tables: { browser_tasks: selects(FAILED_TASK) } });
  const { status, body } = await json(fixture, "POST", "/browser/takeovers", {
    browserTaskId: "task-1",
  });

  expect(status).toBe(402);
  expect(body.error).toMatch(/run out of browser credit/);
});

/**
 * The login you save, from the route's side (Task 2.4).
 *
 * `lib/browser/credentials.ts` holds the service role and the only plaintext;
 * what is pinned here is the route's half — an API key refused before
 * anything is read, the agent (or the row) read through the caller's own
 * client so RLS decides who may act, every typed refusal turned into a fixed
 * sentence a dialog can show, and no username or password in any response or
 * log line, on any path.
 */
describe("/browser/credentials", () => {
  const AGENT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  const CRED_ID = "0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a";
  const SECRET_USER = "ada.lovelace@example.com";
  const SECRET_PASS = "hunter2-correct-horse";
  const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;

  let save: ReturnType<typeof vi.spyOn>;
  let forget: ReturnType<typeof vi.spyOn>;
  let spoken: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    save = vi.spyOn(credentials, "saveCredential").mockResolvedValue({
      ok: true,
      credential: {
        id: CRED_ID,
        scope: "owner",
        siteHost: "linkedin.com",
        label: "linkedin.com — personal",
        replaced: false,
      },
    });
    forget = vi.spyOn(credentials, "forgetCredential").mockResolvedValue({ ok: true });
    spoken = LEVELS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  });

  /** Everything any console level was handed, as one string. */
  function logged(): string {
    return spoken
      .flatMap((spy) => spy.mock.calls)
      .map((call) =>
        call
          .map((a: unknown) =>
            a instanceof Error ? `${a.message} ${a.stack}` : (JSON.stringify(a) ?? String(a)),
          )
          .join(" "),
      )
      .join("\n");
  }

  const AGENT_ROW = { id: AGENT_ID, workspace_id: WORKSPACE_ID };

  function withTables(tables: FakeDbSpec["tables"], apiKeyId?: string) {
    return appWith({ apiKeyId, tables });
  }

  async function send(
    fixture: ReturnType<typeof appWith>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await fixture.app.request(
      path,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      },
      { BROWSER_USE_API_KEY: "bu_test" } as never,
    );
    const raw = await res.text();
    return {
      status: res.status,
      raw,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
  }

  const SAVE_BODY = {
    agentId: AGENT_ID,
    scope: "owner",
    site: "https://www.LinkedIn.com/login",
    label: "linkedin.com — personal",
    username: SECRET_USER,
    password: SECRET_PASS,
  };

  it.each([
    ["GET", "/browser/credentials"],
    ["POST", "/browser/credentials"],
    ["DELETE", `/browser/credentials/${CRED_ID}`],
  ])("refuses an API key on %s %s before reading anything", async (method, path) => {
    const fixture = withTables(
      { agents: selects(AGENT_ROW), browser_credentials: selects({ id: CRED_ID }) },
      "key-1",
    );
    const { status, body } = await send(
      fixture,
      method,
      path,
      method === "POST" ? SAVE_BODY : undefined,
    );

    expect(status).toBe(403);
    expect(String(body?.error)).toContain("api keys cannot");
    expect(fixture.calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  describe("GET", () => {
    const ROWS = [
      {
        id: CRED_ID,
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        user_id: USER.id,
        scope: "owner",
        site_host: "linkedin.com",
        label: "LinkedIn — personal",
        created_at: "2026-10-01T00:00:00.000Z",
        last_used_at: "2026-10-09T00:00:00.000Z",
      },
      {
        id: "cred-shared",
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        user_id: "user-2",
        scope: "agent",
        site_host: "github.com",
        label: "GitHub — shared",
        created_at: "2026-10-02T00:00:00.000Z",
        last_used_at: null,
      },
    ];

    function listing(role: "admin" | "member") {
      return withTables({
        browser_credentials: { select: () => ({ data: ROWS, error: null }) },
        workspace_members: {
          select: (ctx: QueryContext) => {
            const admins = ctx.filters.some((f) => f.column === "role" && f.value === "admin");
            return {
              data: role === "admin" || !admins ? [{ workspace_id: WORKSPACE_ID, role }] : [],
              error: null,
            };
          },
        },
      });
    }

    it("lists through the caller's own client, granted columns only, never a username", async () => {
      const fixture = listing("member");
      const { status, body, raw } = await send(fixture, "GET", "/browser/credentials");

      expect(status).toBe(200);
      expect(body).toEqual({
        logins: [
          {
            id: CRED_ID,
            agentId: AGENT_ID,
            label: "LinkedIn — personal",
            siteHost: "linkedin.com",
            scope: "owner",
            lastUsedAt: "2026-10-09T00:00:00.000Z",
            createdAt: "2026-10-01T00:00:00.000Z",
            own: true,
            canForget: true,
          },
          {
            id: "cred-shared",
            agentId: AGENT_ID,
            label: "GitHub — shared",
            siteHost: "github.com",
            scope: "agent",
            lastUsedAt: null,
            createdAt: "2026-10-02T00:00:00.000Z",
            own: false,
            // A colleague's shared login: only an admin may forget it.
            canForget: false,
          },
        ],
      });
      const read = fixture.callsTo("browser_credentials")[0];
      expect(read.columns).not.toMatch(/ciphertext|username|password|\*/);
      expect(raw).not.toMatch(/user_id|userId|username/);
    });

    it("lets a workspace admin forget a colleague's shared login", async () => {
      const fixture = listing("admin");
      const { body } = await send(fixture, "GET", "/browser/credentials");

      const logins = body?.logins as Array<{ id: string; canForget: boolean }>;
      expect(logins.find((l) => l.id === "cred-shared")?.canForget).toBe(true);
    });

    it("narrows to one agent when asked", async () => {
      const fixture = listing("member");
      await send(fixture, "GET", `/browser/credentials?agentId=${AGENT_ID}`);

      expect(fixture.callsTo("browser_credentials")[0].filters).toContainEqual({
        column: "agent_id",
        value: AGENT_ID,
        kind: "eq",
      });
    });

    it("answers an empty list for an agent id that is not one", async () => {
      const fixture = listing("member");
      const { status, body } = await send(fixture, "GET", "/browser/credentials?agentId=nope");

      expect(status).toBe(200);
      expect(body).toEqual({ logins: [] });
      expect(fixture.callsTo("browser_credentials")).toEqual([]);
    });
  });

  describe("POST", () => {
    it("reads the agent through the caller's own client, then saves with the row's workspace", async () => {
      const fixture = withTables({ agents: selects(AGENT_ROW) });
      const { status, body, raw } = await send(fixture, "POST", "/browser/credentials", SAVE_BODY);

      expect(status).toBe(200);
      expect(body).toEqual({
        credential: {
          id: CRED_ID,
          scope: "owner",
          siteHost: "linkedin.com",
          label: "linkedin.com — personal",
          replaced: false,
        },
      });
      const read = fixture.callsTo("agents")[0];
      expect(read.filters).toContainEqual({ column: "id", value: AGENT_ID, kind: "eq" });
      expect(save.mock.calls[0][1]).toEqual({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        userId: USER.id,
        scope: "owner",
        siteHost: SAVE_BODY.site,
        label: SAVE_BODY.label,
        username: SECRET_USER,
        password: SECRET_PASS,
      });
      expect(raw).not.toContain(SECRET_USER);
      expect(raw).not.toContain(SECRET_PASS);
      expect(logged()).not.toContain(SECRET_USER);
      expect(logged()).not.toContain(SECRET_PASS);
    });

    /**
     * R34, 0021's line: shared things need a member, yours need only
     * membership. A viewer may use the agent and save a login for themself,
     * but not one every colleague's runs will sign in with.
     */
    describe("a login for everyone (R34)", () => {
      function asRole(role: string | null) {
        return withTables({
          agents: selects(AGENT_ROW),
          workspace_members: {
            select: (ctx: QueryContext) => {
              const mine =
                ctx.filters.some((f) => f.column === "user_id" && f.value === USER.id) &&
                ctx.filters.some((f) => f.column === "workspace_id" && f.value === WORKSPACE_ID);
              return { data: mine && role ? { role } : null, error: null };
            },
          },
        });
      }
      const SHARED = { ...SAVE_BODY, scope: "agent", label: "linkedin.com — shared" };

      it("refuses a viewer, through the caller's own client, before anything is saved", async () => {
        const fixture = asRole("viewer");
        const { status, body } = await send(fixture, "POST", "/browser/credentials", SHARED);

        expect(status).toBe(403);
        expect(body).toEqual({
          error:
            "Only workspace members who can edit can save a login for everyone. Save it for yourself instead.",
        });
        expect(save).not.toHaveBeenCalled();
        expect(fixture.callsTo("workspace_members")[0].filters).toContainEqual({
          column: "workspace_id",
          value: WORKSPACE_ID,
          kind: "eq",
        });
      });

      it("refuses a caller with no membership row at all", async () => {
        const { status } = await send(asRole(null), "POST", "/browser/credentials", SHARED);
        expect(status).toBe(403);
        expect(save).not.toHaveBeenCalled();
      });

      it.each(["member", "admin"])("saves for a %s", async (role) => {
        const { status } = await send(asRole(role), "POST", "/browser/credentials", SHARED);
        expect(status).toBe(200);
        expect(save.mock.calls[0][1]).toMatchObject({ scope: "agent" });
      });

      it("lets a viewer save a login for themself", async () => {
        const fixture = asRole("viewer");
        const { status } = await send(fixture, "POST", "/browser/credentials", SAVE_BODY);
        expect(status).toBe(200);
        expect(save.mock.calls[0][1]).toMatchObject({ scope: "owner" });
      });
    });

    it("404s an agent the caller cannot use, before anything is saved", async () => {
      const fixture = withTables({ agents: selects(null) });
      const { status } = await send(fixture, "POST", "/browser/credentials", SAVE_BODY);

      expect(status).toBe(404);
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ["no agent id", { ...SAVE_BODY, agentId: undefined }],
      ["an agent id that is not one", { ...SAVE_BODY, agentId: "agent-1" }],
    ])("refuses %s without reading anything", async (_label, payload) => {
      const fixture = withTables({ agents: selects(AGENT_ROW) });
      const { status } = await send(fixture, "POST", "/browser/credentials", payload);

      expect(status).toBe(400);
      expect(fixture.calls).toEqual([]);
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ["invalid_scope", 400, "A login is saved either for you or for everyone using this agent."],
      ["invalid_host", 400, "That is not a website address a login can be saved for."],
      ["invalid_label", 400, "Give the login a name, like “LinkedIn — sales account”."],
      ["label_is_username", 400, "The name is shown to others, so it cannot contain the username."],
      ["label_is_password", 400, "The name is shown to others, so it cannot contain the password."],
      ["invalid_username", 400, "The username must be between 1 and 2048 bytes."],
      ["invalid_password", 400, "The password must be between 1 and 2048 bytes."],
      ["agent_not_found", 404, "That agent is not in this workspace."],
      [
        "shared_exists",
        409,
        "A shared login for linkedin.com already exists. Ask a workspace admin, or whoever saved it, to remove it first.",
      ],
    ])("answers %s with a fixed sentence", async (reason, expectedStatus, sentence) => {
      save.mockResolvedValue({ ok: false, reason, message: "the library's words" } as never);
      const fixture = withTables({ agents: selects(AGENT_ROW) });
      const { status, body, raw } = await send(fixture, "POST", "/browser/credentials", SAVE_BODY);

      expect(status).toBe(expectedStatus);
      expect(body).toEqual({ error: sentence });
      expect(raw).not.toContain(SECRET_USER);
      expect(raw).not.toContain(SECRET_PASS);
      expect(logged()).not.toContain(SECRET_USER);
      expect(logged()).not.toContain(SECRET_PASS);
    });

    it("answers a failed save with a sentence that carries no value, and logs none", async () => {
      save.mockRejectedValue(new Error("browser_credentials: insert failed (23502)"));
      const fixture = withTables({ agents: selects(AGENT_ROW) });
      const { status, body, raw } = await send(fixture, "POST", "/browser/credentials", SAVE_BODY);

      expect(status).toBe(500);
      expect(body).toEqual({ error: "Couldn't save that login. Try again in a moment." });
      expect(raw).not.toContain(SECRET_USER);
      expect(raw).not.toContain(SECRET_PASS);
      expect(logged()).not.toContain(SECRET_USER);
      expect(logged()).not.toContain(SECRET_PASS);
    });
  });

  describe("DELETE", () => {
    it("404s an id that is not a uuid, before anything is read", async () => {
      const fixture = withTables({ browser_credentials: selects({ id: CRED_ID }) });
      const { status } = await send(fixture, "DELETE", "/browser/credentials/not-a-uuid");

      expect(status).toBe(404);
      expect(fixture.calls).toEqual([]);
      expect(forget).not.toHaveBeenCalled();
    });

    it("404s a login the caller's own client cannot see", async () => {
      const fixture = withTables({ browser_credentials: selects(null) });
      const { status } = await send(fixture, "DELETE", `/browser/credentials/${CRED_ID}`);

      expect(status).toBe(404);
      expect(forget).not.toHaveBeenCalled();
    });

    it("forgets, as the caller, and answers 204", async () => {
      const fixture = withTables({ browser_credentials: selects({ id: CRED_ID }) });
      const { status } = await send(fixture, "DELETE", `/browser/credentials/${CRED_ID}`);

      expect(status).toBe(204);
      expect(forget.mock.calls[0][1]).toEqual({ credentialId: CRED_ID, userId: USER.id });
    });

    it.each([
      ["not_found", 404, "That saved login is not there any more."],
      ["forbidden", 403, "Only a workspace admin, or whoever saved it, can remove a shared login."],
    ])("answers %s with a fixed sentence", async (reason, expectedStatus, sentence) => {
      forget.mockResolvedValue({ ok: false, reason } as never);
      const fixture = withTables({ browser_credentials: selects({ id: CRED_ID }) });
      const { status, body } = await send(fixture, "DELETE", `/browser/credentials/${CRED_ID}`);

      expect(status).toBe(expectedStatus);
      expect(body).toEqual({ error: sentence });
    });
  });
});

/**
 * R24: Save on the sign-in card hands the browser back with the login
 * attached. The client names the site and nothing else; the binding is
 * resolved here, for the caller, by `credentialsFor` — plaintext never
 * arrives from the client on this call.
 */
describe("POST /browser/sessions/:id/hand-back with a site", () => {
  const HUMAN = { id: "bs-1", live_state: "human", human_since: "2026-10-10T12:00:00.000Z" };
  const ORIGINAL = {
    id: "bt-0",
    workspace_id: WORKSPACE_ID,
    agent_id: "agent-1",
    user_id: USER.id,
    session_id: "chat-1",
    task: "read the pricing table",
    retry_of: null,
    status: "failed",
    stop_reason: "login_required",
  };
  const LOGIN = {
    id: "cred-1",
    label: "LinkedIn — shared",
    scope: "agent" as const,
    siteHost: "linkedin.com",
    aliases: { username: "linkedin_com_username", password: "linkedin_com_password" },
    bindings: [],
  };

  let hand: ReturnType<typeof vi.spyOn>;
  let resolveLogin: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hand = vi
      .spyOn(controls, "handBackBrowser")
      .mockResolvedValue({ kind: "ok", browserTaskId: "bt-1" });
    resolveLogin = vi.spyOn(credentials, "credentialsFor").mockResolvedValue(LOGIN as never);
  });

  async function handBack(body?: unknown) {
    const fixture = appWith({
      tables: { browser_sessions: selects(HUMAN), browser_tasks: selects(ORIGINAL) },
    });
    const res = await fixture.app.request(
      "/browser/sessions/bs-1/hand-back",
      {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { BROWSER_USE_API_KEY: "bu_test" } as never,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("resolves the caller's binding for the normalised site and carries it", async () => {
    const { status, body } = await handBack({ site: "https://www.LinkedIn.com/login" });

    expect(status).toBe(200);
    expect(body).toEqual({ browserTaskId: "bt-1" });
    expect(resolveLogin.mock.calls[0][1]).toEqual({
      agentId: "agent-1",
      userId: USER.id,
      host: "linkedin.com",
    });
    expect(hand.mock.calls[0][1]).toEqual({
      browserSessionId: "bs-1",
      userId: USER.id,
      original: ORIGINAL,
      login: LOGIN,
    });
  });

  /**
   * R35: the save's own id goes with the hand-back, so the run binds the login
   * just saved rather than one `pick` would prefer. `credentialsFor` decides
   * whether the caller may use it; the route only passes it on.
   */
  it("passes the saved login's id on as a preference", async () => {
    const credentialId = "0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a";
    const { status } = await handBack({ site: "linkedin.com", credentialId });

    expect(status).toBe(200);
    expect(resolveLogin.mock.calls[0][1]).toEqual({
      agentId: "agent-1",
      userId: USER.id,
      host: "linkedin.com",
      prefer: credentialId,
    });
  });

  it("400s a credential id that is not one, before the retry is spent", async () => {
    const { status } = await handBack({ site: "linkedin.com", credentialId: "cred-1" });

    expect(status).toBe(400);
    expect(resolveLogin).not.toHaveBeenCalled();
    expect(hand).not.toHaveBeenCalled();
  });

  it("is exactly today's hand-back with no body, or a body without a site", async () => {
    for (const body of [undefined, {}]) {
      hand.mockClear();
      const { status } = await handBack(body);
      expect(status).toBe(200);
      expect(hand.mock.calls[0][1]).toEqual({
        browserSessionId: "bs-1",
        userId: USER.id,
        original: ORIGINAL,
      });
    }
    expect(resolveLogin).not.toHaveBeenCalled();
  });

  it.each([
    ["a site that is not a host", { site: "not a site" }],
    ["a site that is not a string", { site: 42 }],
  ])("400s %s, before the retry is spent", async (_label, body) => {
    const { status } = await handBack(body);

    expect(status).toBe(400);
    expect(resolveLogin).not.toHaveBeenCalled();
    expect(hand).not.toHaveBeenCalled();
  });

  it("409s when there is no saved login the caller may use, before the retry is spent", async () => {
    resolveLogin.mockResolvedValue(null);
    const { status, body } = await handBack({ site: "linkedin.com" });

    expect(status).toBe(409);
    expect(String(body.error)).toContain("linkedin.com");
    expect(hand).not.toHaveBeenCalled();
  });

  it("500s, without spending the retry, when the login cannot be read", async () => {
    resolveLogin.mockRejectedValue(new Error("browser_credentials: read failed (57014)"));
    const { status } = await handBack({ site: "linkedin.com" });

    expect(status).toBe(500);
    expect(hand).not.toHaveBeenCalled();
  });
});

/**
 * Settings → Browser sign-ins, its third part (Task 3.2, ruling R48): the
 * browsers of this person that may still be open, each with where it is and
 * who has it, so they can be found and stopped from one place.
 *
 * Pinned here: an API key refused before anything is read; every row read
 * through the caller's own client and only granted columns asked for; whether
 * a browser is open answered by the module as a boolean, for the caller's own
 * ids; and nothing in the answer that is a provider id or a live URL — this
 * screen never mints one, and asks the provider nothing.
 */
describe("GET /browser/sessions", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const ROWS = [
    // The agent is driving: a run is going in it.
    {
      id: "bs-agent",
      chat_session_id: "chat-1",
      agent_id: "agent-1",
      live_state: "agent",
      human_since: null,
      last_run_at: minutesAgo(1),
    },
    // In the person's hands; the tab's heartbeat moved `human_since` lately.
    {
      id: "bs-human",
      chat_session_id: "chat-2",
      agent_id: "agent-1",
      live_state: "human",
      human_since: minutesAgo(2),
      last_run_at: minutesAgo(30),
    },
    // Nobody's, its browser not yet seen stopped: the idle sweep's.
    {
      id: "bs-idle",
      chat_session_id: "chat-3",
      agent_id: "agent-2",
      live_state: "none",
      human_since: null,
      last_run_at: minutesAgo(4),
    },
    // Nobody's, and its browser already stopped (the module says so).
    {
      id: "bs-stopped",
      chat_session_id: "chat-4",
      agent_id: "agent-1",
      live_state: "none",
      human_since: null,
      last_run_at: minutesAgo(6),
    },
    // Nobody's, its last run past the provider's four-hour lifetime: nothing
    // can be running, so nobody is asked about it.
    {
      id: "bs-ancient",
      chat_session_id: "chat-5",
      agent_id: "agent-1",
      live_state: "none",
      human_since: null,
      last_run_at: minutesAgo(5 * 60),
    },
  ];
  const GRANTED = new Set([
    "id",
    "user_id",
    "workspace_id",
    "agent_id",
    "chat_session_id",
    "live_state",
    "human_since",
    "last_run_at",
    "created_at",
  ]);
  const TAKEOVER_GRANTED = new Set([
    "id",
    "user_id",
    "workspace_id",
    "profile_id",
    "browser_task_id",
    "status",
    "expires_at",
    "created_at",
    "closed_at",
  ]);

  let openAmong: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openAmong = vi
      .spyOn(live, "openBrowsersAmong")
      .mockResolvedValue(new Set(["bs-idle", "bs-human"]));
  });

  function listing(
    over: {
      rows?: Array<Record<string, unknown>>;
      takeover?: Record<string, unknown> | null;
      apiKeyId?: string;
    } = {},
  ) {
    return appWith({
      apiKeyId: over.apiKeyId,
      tables: {
        browser_sessions: { select: () => ({ data: over.rows ?? ROWS, error: null }) },
        browser_tasks: {
          select: (ctx) => {
            // The takeover's own task, by id; otherwise the runs in flight.
            if (ctx.filters.some((f) => f.column === "id")) {
              return {
                data: { id: "bt-v2", session_id: "chat-9", agent_id: "agent-2" },
                error: null,
              };
            }
            return { data: [{ browser_session_id: "bs-agent" }], error: null };
          },
        },
        browser_takeovers: { select: () => ({ data: over.takeover ?? null, error: null }) },
        // chat-2 is a conversation the caller can no longer see.
        chat_sessions: {
          select: () => ({
            data: [
              { id: "chat-1", title: "Supplier pricing" },
              { id: "chat-3", title: null },
              { id: "chat-9", title: "The portal" },
            ],
            error: null,
          }),
        },
        agents: {
          select: () => ({
            data: [
              { id: "agent-1", name: "Researcher" },
              { id: "agent-2", name: "Scout" },
            ],
            error: null,
          }),
        },
      },
    });
  }

  async function list(fixture: ReturnType<typeof appWith>) {
    return json(fixture, "GET", "/browser/sessions");
  }

  type Listed = {
    browsers: Array<Record<string, unknown>>;
    takeover: Record<string, unknown> | null;
  };

  it("refuses an API key before reading anything", async () => {
    const fixture = listing({ apiKeyId: "key-1" });
    const { status, body } = await list(fixture);

    expect(status).toBe(403);
    expect(String(body.error)).toContain("api keys cannot");
    expect(fixture.calls.filter((c) => c.table.startsWith("browser_"))).toEqual([]);
    expect(openAmong).not.toHaveBeenCalled();
  });

  it("reads the caller's own rows through their own client, and only granted columns", async () => {
    const fixture = listing({
      takeover: {
        id: "to-1",
        browser_task_id: null,
        expires_at: minutesAgo(-8),
        created_at: minutesAgo(2),
      },
    });
    await list(fixture);

    const read = fixture.calls.find((c) => c.table === "browser_sessions");
    expect(read?.filters).toContainEqual({ column: "user_id", value: USER.id, kind: "eq" });
    for (const column of String(read?.columns).split(",")) {
      expect(GRANTED.has(column.trim()), column).toBe(true);
    }
    // M7: PostgREST answers at most a thousand rows; newest first, so a
    // person with more conversations than that loses the ancient ones from
    // the list, never the browser they used a minute ago.
    expect(read?.order).toEqual([{ column: "last_run_at", ascending: false }]);
    const takeoverRead = fixture.calls.find((c) => c.table === "browser_takeovers");
    expect(takeoverRead?.filters).toContainEqual({
      column: "user_id",
      value: USER.id,
      kind: "eq",
    });
    expect(takeoverRead?.filters).toContainEqual({ column: "status", value: "open", kind: "eq" });
    for (const column of String(takeoverRead?.columns).split(",")) {
      expect(TAKEOVER_GRANTED.has(column.trim()), column).toBe(true);
    }
  });

  it("asks the module about the caller's own ids, and not about a browser past its lifetime", async () => {
    const fixture = listing();
    await list(fixture);

    expect(openAmong).toHaveBeenCalledTimes(1);
    const asked = openAmong.mock.calls[0][1] as { userId: string; browserSessionIds: string[] };
    expect(asked.userId).toBe(USER.id);
    expect([...asked.browserSessionIds].sort()).toEqual([
      "bs-agent",
      "bs-human",
      "bs-idle",
      "bs-stopped",
    ]);
  });

  it("lists the browsers that may be open — the agent's, the person's, the idle — and not a stopped one", async () => {
    const { status, body } = await list(listing());

    expect(status).toBe(200);
    const ids = (body as unknown as Listed).browsers.map((b) => b.id);
    expect(ids.sort()).toEqual(["bs-agent", "bs-human", "bs-idle"]);
  });

  it("says where each one is and who has it, with a neutral answer for a conversation out of sight", async () => {
    const { body } = await list(listing());
    const byId = Object.fromEntries(
      (body as unknown as Listed).browsers.map((b) => [String(b.id), b]),
    );

    expect(byId["bs-agent"]).toMatchObject({
      conversation: { id: "chat-1", title: "Supplier pricing" },
      agent: { id: "agent-1", name: "Researcher" },
      liveState: "agent",
      running: true,
      browserOpen: false,
    });
    expect(byId["bs-human"]).toMatchObject({
      conversation: null,
      liveState: "human",
      running: false,
      browserOpen: true,
    });
    expect(byId["bs-idle"]).toMatchObject({
      conversation: { id: "chat-3", title: null },
      agent: { id: "agent-2", name: "Scout" },
      liveState: "none",
      running: false,
      browserOpen: true,
    });
    // When it was last used: the later of the last run and the tab's heartbeat.
    expect(byId["bs-human"].lastUsedAt).toBe(ROWS[1].human_since);
    expect(byId["bs-idle"].lastUsedAt).toBe(ROWS[2].last_run_at);
  });

  /**
   * Ruling R51 (c): whether Stop would be accepted, decided by the stop
   * route's own rule — no run in flight, and an `agent` row only ten minutes
   * after its last run — so Settings offers Stop exactly when it works. A
   * boolean; no provider value.
   */
  it("says which ones a Stop would be accepted on", async () => {
    const rows = [
      ...ROWS,
      {
        id: "bs-left-recent",
        chat_session_id: "chat-1",
        agent_id: "agent-1",
        live_state: "agent",
        human_since: null,
        last_run_at: minutesAgo(5),
      },
      {
        id: "bs-left-old",
        chat_session_id: "chat-1",
        agent_id: "agent-1",
        live_state: "agent",
        human_since: null,
        last_run_at: minutesAgo(11),
      },
    ];
    const { body } = await list(listing({ rows }));
    const byId = Object.fromEntries(
      (body as unknown as Listed).browsers.map((b) => [String(b.id), b]),
    );

    expect(byId["bs-agent"]).toMatchObject({ running: true, stoppable: false });
    expect(byId["bs-human"]).toMatchObject({ stoppable: true });
    expect(byId["bs-idle"]).toMatchObject({ stoppable: true });
    expect(byId["bs-left-recent"]).toMatchObject({ running: false, stoppable: false });
    expect(byId["bs-left-old"]).toMatchObject({ running: false, stoppable: true });
  });

  it("asks which runs are in flight through the caller's own client, for these browsers only", async () => {
    const fixture = listing();
    await list(fixture);

    const runs = fixture.calls.find(
      (c) => c.table === "browser_tasks" && c.filters.some((f) => f.column === "status"),
    );
    expect(runs?.filters).toContainEqual({
      column: "status",
      value: ["queued", "running"],
      kind: "in",
    });
    const named = runs?.filters.find((f) => f.column === "browser_session_id");
    expect([...(named?.value as string[])].sort()).toEqual(["bs-agent", "bs-human", "bs-idle"]);
  });

  it("carries no provider id and no live URL, and asks the provider nothing", async () => {
    const { body } = await list(
      listing({
        takeover: {
          id: "to-1",
          browser_task_id: null,
          expires_at: minutesAgo(-8),
          created_at: minutesAgo(2),
        },
      }),
    );

    const said = JSON.stringify(body);
    expect(said).not.toMatch(/provider|liveUrl|live_url|cdp/i);
    expect(session).not.toHaveBeenCalled();
    expect(liveUrl).not.toHaveBeenCalled();
  });

  it("names the caller's own open browser, which belongs to no conversation", async () => {
    const takeover = {
      id: "to-1",
      browser_task_id: null,
      expires_at: minutesAgo(-8),
      created_at: minutesAgo(2),
    };
    const { body } = await list(listing({ takeover }));

    expect((body as unknown as Listed).takeover).toEqual({
      id: "to-1",
      forTask: false,
      conversation: null,
      agent: null,
      openedAt: takeover.created_at,
      expiresAt: takeover.expires_at,
    });
  });

  it("names a task's takeover by the conversation its task was asked in", async () => {
    const takeover = {
      id: "to-2",
      browser_task_id: "bt-v2",
      expires_at: minutesAgo(-8),
      created_at: minutesAgo(2),
    };
    const fixture = listing({ takeover });
    const { body } = await list(fixture);

    expect((body as unknown as Listed).takeover).toMatchObject({
      id: "to-2",
      forTask: true,
      conversation: { id: "chat-9", title: "The portal" },
      agent: { id: "agent-2", name: "Scout" },
    });
    const task = fixture.calls.find(
      (c) => c.table === "browser_tasks" && c.filters.some((f) => f.column === "id"),
    );
    expect(task?.filters).toContainEqual({ column: "id", value: "bt-v2", kind: "eq" });
  });

  /**
   * Fails closed. A row drawn as not running offers a Stop, which under a run
   * the stop route refuses (R50) because it would kill the agent's run (R17,
   * R48). Not knowing which runs are going must therefore read as "the agent's
   * rows are running", never as "nothing is".
   */
  it("treats every agent row as running when the runs cannot be read", async () => {
    const fixture = appWith({
      tables: {
        browser_sessions: { select: () => ({ data: ROWS, error: null }) },
        browser_tasks: {
          select: () => ({ data: null, error: { message: "boom", code: "57014" } }),
        },
        browser_takeovers: { select: () => ({ data: null, error: null }) },
        chat_sessions: { select: () => ({ data: [], error: null }) },
        agents: { select: () => ({ data: [], error: null }) },
      },
    });
    const { status, body } = await list(fixture);

    expect(status).toBe(200);
    const byId = Object.fromEntries(
      (body as unknown as Listed).browsers.map((b) => [String(b.id), b]),
    );
    expect(byId["bs-agent"]).toMatchObject({ liveState: "agent", running: true });
    // The person's own and the idle one are nobody's run, and keep their Stop.
    expect(byId["bs-human"]).toMatchObject({ running: false });
    expect(byId["bs-idle"]).toMatchObject({ running: false });
  });

  it("still lists what the rows themselves say when it cannot tell which browsers are open", async () => {
    openAmong.mockResolvedValue(null);
    const { status, body } = await list(listing());

    expect(status).toBe(200);
    const ids = (body as unknown as Listed).browsers.map((b) => b.id);
    expect(ids.sort()).toEqual(["bs-agent", "bs-human"]);
  });

  it("answers an empty list, and asks nothing more, when the caller has no browsers", async () => {
    const fixture = listing({ rows: [] });
    const { status, body } = await list(fixture);

    expect(status).toBe(200);
    expect(body).toEqual({ browsers: [], takeover: null });
    expect(fixture.calls.filter((c) => c.table === "chat_sessions")).toEqual([]);
    expect(fixture.calls.filter((c) => c.table === "agents")).toEqual([]);
  });

  it("500s when the caller's own rows cannot be read", async () => {
    const fixture = appWith({
      tables: {
        browser_sessions: {
          select: () => ({ data: null, error: { message: "boom", code: "XX000" } }),
        },
      },
    });
    const { status } = await list(fixture);

    expect(status).toBe(500);
    expect(openAmong).not.toHaveBeenCalled();
  });
});
