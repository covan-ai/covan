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
      signedInTo: ["portal.example.com"],
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
      signedInTo: ["portal.example.com", "mail.example.com"],
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
