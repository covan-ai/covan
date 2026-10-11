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

  it("answers none for a row past its window, so a new one can be opened", async () => {
    const fixture = appWith({
      tables: {
        browser_takeovers: selects({
          ...OPEN_ROW,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    });
    const { body } = await json(fixture, "GET", "/browser/takeovers/current");

    expect(body.takeover).toBeNull();
    // Nothing asked the provider: an expired row is not somebody's live
    // browser, and POST is what closes it.
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
  });

  describe("POST …/stop", () => {
    it("stops the browser and answers 204", async () => {
      const fixture = withSession({ ...SESSION, live_state: "human" });
      const { status, body } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(204);
      expect(body).toBeNull();
      expect(stop.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1", userId: USER.id });
    });

    it("passes a failed stop through with its status", async () => {
      stop.mockResolvedValue({ kind: "error", status: 502, message: "could not stop it" });
      const fixture = withSession(SESSION);
      const { status } = await call(fixture, "POST", "/browser/sessions/bs-1/stop");

      expect(status).toBe(502);
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
