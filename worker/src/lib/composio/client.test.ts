import { describe, it, expect, vi } from "vitest";
import {
  allowedLogoUrl,
  composioConfigured,
  createLink,
  executeTool,
  getConnectedAccount,
  authConfigPlanFor,
  connectsWithoutAccount,
  getToolkit,
  listToolkitCategories,
  listToolkits,
  listToolkitTools,
  MAX_TOOLS_PAGE,
  searchTools,
  statusOf,
  type ComposioEnv,
  type ComposioToolkit,
} from "./client";

/**
 * The endpoints Covan uses, and the defensive reading around them.
 *
 * Much of what is asserted here is tolerance of shape: the list wrapper, the
 * toolkit as a string or as `{slug}`, the description under `meta`. A field
 * name that is load-bearing across a version bump is a thing to notice rather
 * than assume — `toolkit` in particular decides whether `run_tool` will accept
 * a slug at all.
 *
 * The rest was written against the live API rather than its documentation,
 * after a read of the docs got `createLink`'s body wrong and a single probe
 * settled it. Where a test names an exact field or an exact call order, that
 * is what the API actually did.
 */
const ENV: ComposioEnv = { COMPOSIO_API_KEY: "ck_test" };

function fetchReturning(body: unknown, status = 200) {
  // The parameters are declared so `mock.calls` is typed as the pair this file
  // asserts on — a zero-argument fake records a zero-length tuple.
  return vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
}

describe("composioConfigured", () => {
  it("is the one question every surface asks, so chat and a schedule agree", () => {
    expect(composioConfigured({})).toBe(false);
    expect(composioConfigured(ENV)).toBe(true);
  });
});

describe("listToolkitTools", () => {
  it("asks for one application's operations, with the slug uppercased", async () => {
    const fetchImpl = fetchReturning({ items: [] });
    await listToolkitTools(ENV, { toolkit: "gmail" }, { fetchImpl: fetchImpl as never });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v3.1/tools");
    expect(url.searchParams.get("toolkit_slug")).toBe("GMAIL");
    // No `search`. That is the whole difference from `searchTools`, whose own
    // required query is load-bearing for `find_tool`'s short retry.
    expect(url.searchParams.has("search")).toBe(false);
  });

  it("drops a row belonging to another application", async () => {
    // The defence that matters, and not a hypothetical: `authConfigFor` records
    // the rule — an API that ignores a filter it does not know returns
    // EVERYTHING — and production has seen what everything looks like, an
    // alphabetical catalogue answering `_2chat` and `active_campaign`. Without
    // this, a `toolkit_slug` Composio declined to honour would put somebody
    // else's operations on Gmail's card.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail" },
      {
        fetchImpl: fetchReturning({
          items: [
            { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } },
            { slug: "LINEAR_CREATE_ISSUE", toolkit: { slug: "LINEAR" } },
          ],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.tools.map((t) => t.slug)).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("counts a total only when a short page proves one", async () => {
    // Composio publishes no count on this endpoint that anybody here has
    // verified, so the only honest total is the one the page itself proves:
    // fewer rows than asked for, and no cursor, means this is all of them.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 10 },
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } }],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.total).toBe(1);
    expect(out.kind === "ok" && out.more).toBe(false);
  });

  it("takes the catalogue's own count when the page does not contradict it", async () => {
    // Composio's reference documents `total_items`. Documented is not deployed
    // — covan#172 is three published shapes their own API rejects — so it is
    // read only when it survives being checked.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 1 },
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } }],
          total_items: 247,
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.total).toBe(247);
  });

  it("ignores a published count that is smaller than the page in hand", async () => {
    // Not a total of anything. A field that disagrees with what it arrived
    // beside is a field meaning something else, and rendering it would be the
    // unbacked number DESIGN.md forbids.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 1 },
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } }],
          total_items: 0,
          next_cursor: "abc",
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.total).toBeNull();
  });

  it("ignores a published count when the filter was not honoured", async () => {
    // A foreign row means `toolkit_slug` was ignored, and then every count in
    // the body counts the whole catalogue rather than this application.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 5 },
      {
        fetchImpl: fetchReturning({
          items: [
            { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } },
            { slug: "LINEAR_CREATE_ISSUE", toolkit: { slug: "LINEAR" } },
          ],
          total_items: 1562,
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.total).toBeNull();
  });

  it("claims no total when the catalogue said there was more", async () => {
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 1 },
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } }],
          next_cursor: "abc",
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.total).toBeNull();
    expect(out.kind === "ok" && out.more).toBe(true);
  });

  it("does not let a dropped foreign row fake a short page", async () => {
    // Counted off what Composio returned, not off what survived the filter.
    // Two rows back for a limit of two is a full page, whatever we then drop —
    // and a total of one here would be an invented number.
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail", limit: 2 },
      {
        fetchImpl: fetchReturning({
          items: [
            { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } },
            { slug: "LINEAR_CREATE_ISSUE", toolkit: { slug: "LINEAR" } },
          ],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.tools).toHaveLength(1);
    expect(out.kind === "ok" && out.total).toBeNull();
  });

  it("returns a failure rather than throwing, like everything else in this file", async () => {
    const out = await listToolkitTools(
      ENV,
      { toolkit: "gmail" },
      { fetchImpl: fetchReturning({ error: "nope" }, 502) as never },
    );
    expect(out.kind).toBe("error");
  });
});

describe("searchTools", () => {
  it("sends the API key as Composio's own header and never as Authorization", async () => {
    const fetchImpl = fetchReturning({ items: [] });
    await searchTools(ENV, { search: "send mail" }, { fetchImpl: fetchImpl as never });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ck_test");
    expect(headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe("manual");
  });

  it("reads a list whether it arrives as items or as data", async () => {
    const row = { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" } };
    for (const body of [{ items: [row] }, { data: [row] }, [row]]) {
      const out = await searchTools(
        ENV,
        { search: "x" },
        { fetchImpl: fetchReturning(body) as never },
      );
      expect(out.kind === "ok" && out.tools[0].slug).toBe("GMAIL_SEND_EMAIL");
      expect(out.kind === "ok" && out.tools[0].toolkit).toBe("gmail");
    }
  });

  it("falls back to the slug's own prefix when no toolkit is named", async () => {
    // A convention rather than a promise, which is why it is the last resort:
    // `run_tool` compares this to the connection's toolkit before it will send
    // anything, so getting it wrong means a refusal rather than a wrong call.
    const out = await searchTools(
      ENV,
      { search: "x" },
      { fetchImpl: fetchReturning({ items: [{ slug: "LINEAR_CREATE_ISSUE" }] }) as never },
    );
    expect(out.kind === "ok" && out.tools[0].toolkit).toBe("linear");
  });

  it("says nothing about read or write when Composio says nothing", async () => {
    const out = await searchTools(
      ENV,
      { search: "x" },
      { fetchImpl: fetchReturning({ items: [{ slug: "GMAIL_SEND_EMAIL" }] }) as never },
    );
    // Null rather than a guess. Nothing in the permission model branches on it.
    expect(out.kind === "ok" && out.tools[0].destructive).toBeNull();
  });

  it("refuses without a key rather than making an unauthenticated request", async () => {
    const fetchImpl = fetchReturning({ items: [] });
    const out = await searchTools({}, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "error", status: 501 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards the far end's own body on a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded", { status: 402 }));
    const out = await searchTools(ENV, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "error", status: 402 });
    expect(out.kind === "error" && out.message).toContain("quota exceeded");
  });

  it("treats a redirect as an error rather than following it", async () => {
    // Every 3xx, for `lib/routines/delivery.ts`'s reason: a redirect is a
    // request to repeat a credentialed call somewhere we did not name.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    const out = await searchTools(ENV, { search: "x" }, { fetchImpl: fetchImpl as never });
    expect(out.kind).toBe("error");
  });

  it("says the page could not be read rather than reporting an empty catalogue", async () => {
    // The quietest failure in this file until 2026-09-28. `parsed` answers null for
    // anything that is not JSON, `rows(null)` is `[]`, and the caller was handed
    // `{kind:"ok", tools:[]}` — which `find_tool` reports to the person as "no
    // operation in the catalogue matches", having read nothing at all. A gateway's
    // HTML error page is one way in; a page cut at the read cap is the other, and
    // the second became reachable the moment a search started asking for fifty rows.
    const fetchImpl = vi.fn(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
    );
    const out = await searchTools(ENV, { search: "x" }, { fetchImpl: fetchImpl as never });

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("could not be read");
    expect(out.kind === "error" && out.message).toContain("not JSON");
  });

  it("asks for at most the page this file will read, however much a caller wants", async () => {
    // Ours rather than Composio's documented maximum — see `MAX_TOOLS_PAGE`. A
    // caller asking for more must not silently get a page the read cap truncates.
    const fetchImpl = fetchReturning({ items: [] });
    await searchTools(ENV, { search: "x", limit: 500 }, { fetchImpl: fetchImpl as never });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`limit=${MAX_TOOLS_PAGE}`);
  });
});

describe("executeTool", () => {
  it("carries both identifiers in the body, as the caller gave them", async () => {
    const fetchImpl = fetchReturning({ successful: true });
    await executeTool(
      ENV,
      {
        slug: "GMAIL_SEND_EMAIL",
        connectedAccountId: "ca_1",
        userId: "cu_1",
        arguments: { subject: "hi" },
      },
      { fetchImpl: fetchImpl as never },
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v3/tools/execute/GMAIL_SEND_EMAIL");
    expect(JSON.parse(String(init.body))).toEqual({
      connected_account_id: "ca_1",
      user_id: "cu_1",
      arguments: { subject: "hi" },
    });
  });

  it("leaves the account out entirely when the application needs none", async () => {
    // Thirty-four applications execute on `user_id` alone — verified against
    // the live API, which answers `successful: true` for exactly this body.
    //
    // **Absent, not null.** The assertion is on the KEYS, because
    // `connected_account_id: null` would satisfy any check on the value and is
    // the shape covan#172 was three times over: a published request carrying a
    // field their own API rejects. An endpoint validating a discriminated union
    // reads an explicit null as a wrong answer, not as no answer.
    const fetchImpl = fetchReturning({ successful: true });
    await executeTool(
      ENV,
      { slug: "HACKERNEWS_GET_LATEST_POSTS", userId: "cu_open", arguments: {} },
      { fetchImpl: fetchImpl as never },
    );
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.keys(body)).not.toContain("connected_account_id");
    expect(body).toEqual({ user_id: "cu_open", arguments: {} });
  });

  it("leaves it out for an empty account id too, which is what the row hands over", async () => {
    // `composioAccount` returns `connectedAccountId: ""` for a no-auth row
    // rather than omitting the field, so the two have to agree. If this ever
    // sent `connected_account_id: ""` the call would be refused upstream with a
    // message about an account that does not exist.
    const fetchImpl = fetchReturning({ successful: true });
    await executeTool(
      ENV,
      { slug: "HACKERNEWS_GET_USER", connectedAccountId: "", userId: "cu_open", arguments: {} },
      { fetchImpl: fetchImpl as never },
    );
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.keys(body)).not.toContain("connected_account_id");
  });

  const call = {
    slug: "GOOGLECALENDAR_EVENTS_LIST",
    connectedAccountId: "ca_1",
    userId: "cu_1",
    arguments: {},
  };

  it("passes a call the far end actually performed straight through", async () => {
    const fetchImpl = fetchReturning({ successful: true, data: { items: [] } });
    const out = await executeTool(ENV, call, { fetchImpl: fetchImpl as never });
    expect(out.kind).toBe("ok");
  });

  /**
   * Composio answers HTTP 200 for a call the far end refused, with the refusal
   * in the body. Both of these are real, from one production turn: two of its
   * eight steps were Google 400s and both were written into `message_steps`
   * as successes, which is a transcript claiming an agent did something it did
   * not do.
   */
  it("reads a 200 that says it failed as a failure", async () => {
    const fetchImpl = fetchReturning({
      successful: false,
      error: "Invalid request data provided\n- Following fields are missing: {'calendarId'}",
      data: { status_code: 400 },
    });
    const out = await executeTool(ENV, call, { fetchImpl: fetchImpl as never });

    expect(out.kind).toBe("error");
    // The far end's own words, so the model can fix its next call.
    expect(out.kind === "error" && out.message).toContain("calendarId");
  });

  it("still counts that attempt as billed, because it reached them", async () => {
    // `wasBilled` excludes only 501 and 502 — the failures that never left the
    // building. This one left, and Composio charges for it.
    const fetchImpl = fetchReturning({ successful: false, error: "nope" });
    const out = await executeTool(ENV, call, { fetchImpl: fetchImpl as never });
    expect(out.kind === "error" && out.status).toBe(200);
  });

  it("falls back to the whole body when the failure names no reason", async () => {
    const fetchImpl = fetchReturning({ successful: false });
    const out = await executeTool(ENV, call, { fetchImpl: fetchImpl as never });
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("successful");
  });
});

/**
 * Connecting an application, which has a layer the first draft of this file
 * did not have.
 *
 * A link is made against an AUTH CONFIG — Composio's word for the OAuth
 * application for one provider — and not against a toolkit. Sending
 * `{"toolkit": "GMAIL"}` comes back `400 payload.auth_config_id: Required`,
 * which is what these tests exist to stop happening again. The earlier version
 * of this block passed against a fake that answered every call identically and
 * would have shipped the wrong body.
 */
describe("createLink", () => {
  /** A fake that answers each URL differently and records the order. */
  function sequenced(answers: Array<[RegExp, unknown]>) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = answers.find(([re]) => re.test(url));
      return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
    });
    return { impl, calls };
  }

  const LINKED = { connected_account_id: "ca_1", redirect_url: "https://consent.test/x" };
  /** What every test here used to mean by passing no plan at all. */
  const MANAGED = { kind: "managed_oauth" } as const;

  it("reuses an auth config the provider already has", async () => {
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_existing", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, LINKED],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      {
        fetchImpl: impl as never,
      },
    );

    expect(out).toMatchObject({
      kind: "ok",
      connectedAccountId: "ca_1",
      redirectUrl: "https://consent.test/x",
    });
    // Two calls, not three: nothing was created.
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({
      auth_config_id: "ac_existing",
      user_id: "cu_1",
    });
  });

  it("makes one on demand, because the alternative is 1500 dashboard visits", async () => {
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [] }],
      [/auth_configs$/, { toolkit: { slug: "gmail" }, auth_config: { id: "ac_new" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      {
        fetchImpl: impl as never,
      },
    );

    expect(out.kind).toBe("ok");
    expect(calls[1].body).toEqual({
      toolkit: { slug: "GMAIL" },
      auth_config: { type: "use_composio_managed_auth" },
    });
    expect(calls[2].body).toMatchObject({ auth_config_id: "ac_new" });
  });

  /**
   * There is no test here for connecting an application that needs no sign-in,
   * and its absence is the point.
   *
   * There used to be one, asserting the body
   * `{toolkit: {slug: "HACKERNEWS"}, auth_config: {type: "no_auth"}}` — a shape
   * Composio rejects outright (*"Expected 'use_composio_managed_auth' |
   * 'use_custom_auth'"*), as does the only other body it would accept here
   * (*"Cannot create an auth config for toolkit "hackernews" because it does
   * not require authentication"*). The test passed because the fetch was
   * mocked, and all thirty-four of those applications 502'd in production.
   *
   * The fix was to stop coming here at all: such a toolkit has no auth config,
   * no connected account and no link, so `AuthConfigPlan` has no member for one
   * and this function cannot be called with it. `connectsWithoutAccount` and
   * the connect route's own tests are where that path is checked now. Rewriting
   * this as a success case is not possible and would not be desirable — the
   * type is what makes the dead end unreachable.
   */
  it("still expects a page for every flow that gets this far", async () => {
    // The exception that used to live in `needsRedirect` is gone with the plan
    // kind that needed it, so an empty address is now unconditionally a
    // failure. Worth pinning: re-introducing the exception as "not managed" or
    // "has no scheme" is a silent bug — the route inserts a pending row, the
    // browser is handed `{url: ""}` and does nothing at all, and no test fails.
    const { impl } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_1", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, { connected_account_id: "ca_1", redirect_url: "" }],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: { kind: "managed_oauth" } },
      { fetchImpl: impl as never },
    );
    expect(out.kind).toBe("error");
  });

  it("still refuses a sign-in flow that came back with nowhere to go", async () => {
    const { impl } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_existing", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, { connected_account_id: "ca_1" }],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      {
        fetchImpl: impl as never,
      },
    );
    expect(out.kind).toBe("error");
  });

  it("ignores an auth config for another provider, whatever the filter did", async () => {
    // An API that ignores a filter it does not know returns everything, and the
    // first row of everything is somebody else's OAuth application.
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_slack", toolkit: { slug: "slack" } }] }],
      [/auth_configs$/, { auth_config: { id: "ac_gmail" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      { fetchImpl: impl as never },
    );
    expect(calls[2].body).toMatchObject({ auth_config_id: "ac_gmail" });
  });

  it("says what has to be done by hand when there is no ready-made sign-in", async () => {
    const impl = vi.fn(async (url: string) =>
      /auth_configs\?/.test(url)
        ? new Response(JSON.stringify({ items: [] }), { status: 200 })
        : new Response("no managed auth for this toolkit", { status: 400 }),
    );
    const out = await createLink(
      ENV,
      { toolkit: "obscure", userId: "cu_1", plan: MANAGED },
      {
        fetchImpl: impl as never,
      },
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("Composio's dashboard");
  });

  it("asks for a credential config the person connecting fills in, never Covan", async () => {
    // `credentials: {}` is the load-bearing emptiness: it says the credential
    // arrives from whoever connects, at Composio. And `authScheme` is
    // camelCase while the rest of this API is snake_case — sending
    // `auth_scheme` here is a 400, which is how it was found.
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [] }],
      [/auth_configs$/, { auth_config: { id: "ac_key", auth_scheme: "API_KEY" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "posthog", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );

    expect(calls[1].body).toEqual({
      toolkit: { slug: "POSTHOG" },
      auth_config: {
        type: "use_custom_auth",
        authScheme: "API_KEY",
        credentials: {},
        name: "covan:API_KEY",
      },
    });
    expect(out).toMatchObject({ kind: "ok", redirectUrl: "https://consent.test/x" });
  });

  it("will not hand a credential request somebody's OAuth config", async () => {
    // Linear legitimately has both. Matching on the slug alone would send a
    // person after an API key to a consent screen, or hand the next managed
    // connect the API-key config and break the dashboard escape hatch.
    const { impl, calls } = sequenced([
      [
        /auth_configs\?/,
        { items: [{ id: "ac_oauth", toolkit: { slug: "linear" }, is_composio_managed: true }] },
      ],
      [/auth_configs$/, { auth_config: { id: "ac_key", is_composio_managed: false } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "linear", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );
    expect(calls[2].body).toMatchObject({ auth_config_id: "ac_key" });
  });

  it("will not hand a managed request the credential config either", async () => {
    const { impl, calls } = sequenced([
      [
        /auth_configs\?/,
        {
          items: [
            { id: "ac_key", toolkit: { slug: "linear" }, type: "custom", auth_scheme: "API_KEY" },
          ],
        },
      ],
      [/auth_configs$/, { auth_config: { id: "ac_oauth" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "linear", userId: "cu_1", plan: MANAGED },
      { fetchImpl: impl as never },
    );
    expect(calls[2].body).toMatchObject({ auth_config_id: "ac_oauth" });
  });

  it("reuses a credential config by the name we wrote, when the scheme is not listed", async () => {
    // `auth_scheme` is optional on list rows. Without the name as a second
    // key, a project whose list omits it would create a fresh config on every
    // connect, forever — unbounded, where the ceiling should be one.
    const { impl, calls } = sequenced([
      [
        /auth_configs\?/,
        { items: [{ id: "ac_mine", toolkit: { slug: "posthog" }, name: "covan:API_KEY" }] },
      ],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "posthog", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );
    expect(calls[1].body).toMatchObject({ auth_config_id: "ac_mine" });
  });

  it("does not reuse a config Composio has switched off", async () => {
    // The old filter read `is_disabled`, which is not on this shape — the list
    // carries `status` — so a disabled config was reusable, because
    // `undefined !== true`.
    const { impl, calls } = sequenced([
      [
        /auth_configs\?/,
        { items: [{ id: "ac_off", toolkit: { slug: "gmail" }, status: "DISABLED" }] },
      ],
      [/auth_configs$/, { auth_config: { id: "ac_new" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      { fetchImpl: impl as never },
    );
    expect(calls[2].body).toMatchObject({ auth_config_id: "ac_new" });
  });

  it("still reuses a config that says nothing about which kind it is", async () => {
    // Absent is no information, and no information has to mean today's
    // behaviour or every project that omits the field starts duplicating.
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_plain", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      { fetchImpl: impl as never },
    );
    expect(calls[1].body).toMatchObject({ auth_config_id: "ac_plain" });
  });

  it("refuses a config Composio made of the wrong kind, rather than binding to it", async () => {
    // A wrong config is durable and silent: connections bind to it and the
    // only symptom is somebody being asked for the wrong thing months later.
    const { impl } = sequenced([
      [/auth_configs\?/, { items: [] }],
      [/auth_configs$/, { auth_config: { id: "ac_x", auth_scheme: "BASIC" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "posthog", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("BASIC");
  });

  it("refuses a credential link with no page on it, in words somebody can act on", async () => {
    // The trap this replaces: read as "an empty address is fine unless this is
    // managed", a credential link with no page is success — the route inserts
    // a pending row, the browser is told to navigate to "", nothing happens,
    // and no error fires so there is no toast.
    const { impl } = sequenced([
      [
        /auth_configs\?/,
        { items: [{ id: "ac_1", toolkit: { slug: "posthog" }, auth_scheme: "API_KEY" }] },
      ],
      [/connected_accounts\/link/, { connected_account_id: "ca_1" }],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "posthog", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("no page to enter the credential on");
  });

  it("says the credential sign-in would not be set up, not that a client is missing", async () => {
    const impl = vi.fn(async (url: string) =>
      /auth_configs\?/.test(url)
        ? new Response(JSON.stringify({ items: [] }), { status: 200 })
        : new Response("nope", { status: 400 }),
    );
    const out = await createLink(
      ENV,
      { toolkit: "posthog", userId: "cu_1", plan: { kind: "user_credential", scheme: "API_KEY" } },
      { fetchImpl: impl as never },
    );
    expect(out.kind === "error" && out.message).toContain("credential-based sign-in");
    expect(out.kind === "error" && out.message).not.toContain("Composio's dashboard");
  });

  // The third sentence this used to have — the one naming covan#253 for an
  // application that needs no sign-in — is gone with the branch that produced
  // it. That sentence was an apology for a failure, and the failure is fixed:
  // such an application no longer asks Composio for anything.

  it("refuses a link answer missing either half", async () => {
    // A link with no account id produces a row that cannot be polled and cannot
    // be revoked — the exact shape `lib/composio/revoke.ts` exists to prevent.
    const { impl } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_1", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, { redirect_url: "https://consent.test/x" }],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1", plan: MANAGED },
      {
        fetchImpl: impl as never,
      },
    );
    expect(out.kind).toBe("error");
  });
});

/**
 * The question the plan called Step 0 and could not answer without a key.
 *
 * Composio does carry read/write metadata, as MCP tool annotation hints in
 * `tags`. Nothing in the permission model branches on it — a read at a third
 * party pulls private content into a turn as surely as a write changes
 * something — but it is a line on the approval card, and the earlier version
 * of this parser matched none of these because it compared whole array
 * elements against "destructive" rather than "destructiveHint".
 */
describe("read and write", () => {
  async function toolWith(tags: string[]) {
    const out = await searchTools(
      ENV,
      { search: "x" },
      { fetchImpl: fetchReturning({ items: [{ slug: "GMAIL_X", tags }] }) as never },
    );
    return out.kind === "ok" ? out.tools[0].destructive : "error";
  }

  it("reads MCP's hint vocabulary", async () => {
    expect(await toolWith(["important", "openWorldHint", "readOnlyHint"])).toBe(false);
    expect(await toolWith(["destructiveHint", "important"])).toBe(true);
    expect(await toolWith(["openWorldHint", "createHint"])).toBe(true);
    expect(await toolWith(["batch", "labels", "updateHint"])).toBe(true);
  });

  it("says nothing when the operation carries none of them", async () => {
    // A real answer rather than a failure: plenty of operations are annotated
    // with neither, and guessing would put a wrong line on the approval card.
    expect(await toolWith(["gmail", "batch"])).toBeNull();
    expect(await toolWith([])).toBeNull();
  });

  it("believes the narrow claim when an operation carries both", async () => {
    expect(await toolWith(["readOnlyHint", "updateHint"])).toBe(false);
  });
});

describe("listToolkits", () => {
  it("finds the description under meta, where it actually is", async () => {
    // Read from the top level it is silently the empty string, and the card
    // renders a row with a name and nothing under it.
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              auth_schemes: ["OAUTH2"],
              composio_managed_auth_schemes: ["OAUTH2"],
              meta: { description: "Google's email service." },
            },
          ],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0]).toMatchObject({
      slug: "gmail",
      description: "Google's email service.",
      managedAuth: true,
    });
  });

  it("marks an application Composio has no OAuth app of its own for", async () => {
    // Offering Connect on one of these is offering a button whose only outcome
    // is a 400 from a third party.
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "obscure", name: "Obscure", auth_schemes: ["OAUTH2"], meta: {} }],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0].managedAuth).toBe(false);
  });

  it("reads the logo and the categories out of `meta`, where the description was", async () => {
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              no_auth: false,
              meta: {
                description: "Mail",
                logo: "https://logos.composio.dev/api/gmail",
                categories: [{ id: "Productivity", name: "Productivity" }, "mail"],
              },
            },
          ],
          next_cursor: "page-2",
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0]).toMatchObject({
      logo: "https://logos.composio.dev/api/gmail",
      categories: ["productivity", "mail"],
      noAuth: false,
    });
    expect(out.kind === "ok" && out.nextCursor).toBe("page-2");
  });

  it("drops a logo served from anywhere we do not fetch from", async () => {
    // The mapper is the first of the two places the allowlist is applied, and
    // the cheaper one: an address refused here never reaches the page, so the
    // proxy is never asked about it.
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "x", name: "X", meta: { logo: "https://evil.example.com/x.png" } }],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0].logo).toBe("");
  });

  it("reads `no_auth`, which is the other half of what can be connected today", async () => {
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "hackernews", name: "Hacker News", no_auth: true, meta: {} }],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0]).toMatchObject({
      noAuth: true,
      managedAuth: false,
    });
  });

  it("orders by usage until somebody types, and passes the filter and the page on", async () => {
    // Forty of fifteen hundred in catalogue order is forty applications
    // nobody has heard of. A search brings its own relevance, so we stop
    // sorting the moment there is one.
    const idle = fetchReturning({ items: [] });
    await listToolkits(ENV, { category: "crm", cursor: "c1" }, { fetchImpl: idle as never });
    expect(idle.mock.calls[0][0]).toContain("sort_by=usage");
    expect(idle.mock.calls[0][0]).toContain("category=crm");
    expect(idle.mock.calls[0][0]).toContain("cursor=c1");

    const searched = fetchReturning({ items: [] });
    await listToolkits(ENV, { search: "gm" }, { fetchImpl: searched as never });
    expect(searched.mock.calls[0][0]).not.toContain("sort_by");
    expect(searched.mock.calls[0][0]).toContain("search=gm");
  });
});

describe("getToolkit", () => {
  it("reads one application by slug, for the two answers connect must not take on trust", async () => {
    const out = await getToolkit(ENV, "gmail", {
      fetchImpl: fetchReturning({
        data: {
          slug: "GMAIL",
          name: "Gmail",
          no_auth: false,
          composio_managed_auth_schemes: ["OAUTH2"],
          meta: { logo: "https://logos.composio.dev/api/gmail" },
        },
      }) as never,
    });
    expect(out).toMatchObject({
      kind: "ok",
      toolkit: { slug: "gmail", noAuth: false, logo: "https://logos.composio.dev/api/gmail" },
    });
  });

  it("is an error rather than an empty toolkit when the row has no slug", async () => {
    const out = await getToolkit(ENV, "ghost", {
      fetchImpl: fetchReturning({ data: {} }) as never,
    });
    expect(out.kind).toBe("error");
  });
});

/**
 * What connecting an application requires, which is the question the Connect
 * button asks and for a long time was answered by the wrong two fields.
 *
 * Every fixture below is a real response, trimmed — `fields` objects and modes
 * copied from `/api/v3.1/toolkits/<slug>` on 2026-10-05. The classification
 * turns entirely on whether a mode's required fields are asked of whoever set
 * Covan up or of whoever is connecting, so a fixture with an invented `fields`
 * shape would test nothing but itself.
 */
describe("connectKind", () => {
  const detail = async (row: Record<string, unknown>) => {
    const out = await getToolkit(ENV, "x", { fetchImpl: fetchReturning({ data: row }) as never });
    if (out.kind !== "ok") throw new Error("fixture did not describe a toolkit");
    return out.toolkit;
  };
  const mode = (
    name: string,
    creation: string[] | undefined,
    initiation: string[] | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    mode: name,
    ...extra,
    fields: {
      ...(creation
        ? { auth_config_creation: { required: creation.map((f) => ({ name: f })) } }
        : {}),
      ...(initiation
        ? { connected_account_initiation: { required: initiation.map((f) => ({ name: f })) } }
        : {}),
    },
  });

  it("says a key the user supplies, which is nine tenths of the catalogue", async () => {
    const toolkit = await detail({
      slug: "POSTHOG",
      name: "PostHog",
      composio_managed_auth_schemes: [],
      auth_config_details: [mode("API_KEY", [], ["subdomain", "generic_api_key"])],
    });
    expect(toolkit).toMatchObject({
      connectKind: "user_credential",
      credentialScheme: "API_KEY",
    });
  });

  it("names the scheme, because a key and a password are not the same request", async () => {
    const toolkit = await detail({
      slug: "MIXPANEL",
      name: "Mixpanel",
      auth_config_details: [mode("BASIC", [], ["username", "password"])],
    });
    expect(toolkit).toMatchObject({ connectKind: "user_credential", credentialScheme: "BASIC" });
  });

  it("prefers an API key over the other credentials an application offers", async () => {
    // Datadog publishes three, and the one picked here becomes a durable auth
    // config at Composio — so it must not depend on their array order.
    const toolkit = await detail({
      slug: "DATADOG",
      name: "Datadog",
      auth_config_details: [
        mode("OAUTH2", ["client_id", "client_secret"], ["region"]),
        mode("BEARER_TOKEN", [], ["token", "region", "bearer_token"]),
        mode("API_KEY", [], ["region", "generic_api_key", "generic_id"]),
      ],
    });
    expect(toolkit).toMatchObject({ connectKind: "user_credential", credentialScheme: "API_KEY" });
  });

  it("offers the consent screen when an application has both, so nobody hunts for a key", async () => {
    const toolkit = await detail({
      slug: "LINEAR",
      name: "Linear",
      composio_managed_auth_schemes: ["OAUTH2"],
      auth_config_details: [
        mode("OAUTH2", ["client_id", "client_secret"], []),
        mode("API_KEY", [], ["generic_api_key"]),
      ],
    });
    expect(toolkit).toMatchObject({ connectKind: "managed_oauth", credentialScheme: "" });
  });

  it("still says somebody must register a client, for the fifty that really need one", async () => {
    const toolkit = await detail({
      slug: "DOCUSIGN",
      name: "DocuSign",
      composio_managed_auth_schemes: [],
      auth_config_details: [mode("OAUTH2", ["client_id", "client_secret", "full"], [])],
    });
    expect(toolkit.connectKind).toBe("needs_setup");
  });

  it("refuses a mode that requires nothing of anybody, which is every MCP toolkit", async () => {
    // The ninety-five `DCR_OAUTH` toolkits require nothing at either stage.
    // Classified on "needs nothing from an operator" alone, every one of them
    // would be sent to a hosted page with no field on it.
    const toolkit = await detail({
      slug: "AHREFS_MCP",
      name: "Ahrefs MCP",
      auth_config_details: [mode("DCR_OAUTH", [], undefined)],
    });
    expect(toolkit.connectKind).toBe("needs_setup");
  });

  it("refuses an API key whose key belongs to whoever set Covan up", async () => {
    // `lever` and `brex` both publish one. The rule is about which side of the
    // setup line a required field falls on, not about the scheme's name.
    const toolkit = await detail({
      slug: "LEVER",
      name: "Lever",
      auth_config_details: [mode("API_KEY", ["full"], ["generic_api_key"])],
    });
    expect(toolkit.connectKind).toBe("needs_setup");
  });

  it("reads no-sign-in off the published mode, because the detail row has no such column", async () => {
    // The thing that makes this necessary: `/api/v3.1/toolkits/<slug>` carries
    // no `no_auth` field at all, so a row read on the connect path has it
    // false whatever the truth. All thirty-five fail there for this reason.
    const toolkit = await detail({
      slug: "HACKERNEWS",
      name: "HackerNews",
      composio_managed_auth_schemes: [],
      auth_config_details: [mode("NO_AUTH", [], [])],
    });
    expect(toolkit.connectKind).toBe("no_auth");
  });

  /**
   * `gemini`, the one toolkit that publishes `NO_AUTH` *and* a credential mode.
   *
   * Taken from its live detail record: an empty `NO_AUTH` mode beside an
   * `API_KEY` mode wanting `generic_api_key` from whoever connects. While
   * Connect was broken for the no-auth kind the ambiguity cost nothing. Once it
   * works, calling this one no-auth means it connects **successfully** and then
   * fails on every operation needing the key — at execute time, inside an agent
   * turn, on a card that says "connected", for a step of eight and a billed
   * call. And it cannot heal: a missing credential is not `Tool_ToolNotFound`,
   * so nothing withdraws the slug and the next turn buys the same failure.
   *
   * So no-sign-in has to mean "needs nothing from anybody", not "mentions
   * NO_AUTH". Thirty-four applications, not thirty-five.
   */
  it("does not call an application no-sign-in when it also takes a key", async () => {
    const toolkit = await detail({
      slug: "GEMINI",
      name: "Gemini",
      composio_managed_auth_schemes: [],
      auth_config_details: [mode("NO_AUTH", [], []), mode("API_KEY", [], ["generic_api_key"])],
    });
    expect(toolkit.connectKind).toBe("user_credential");
    expect(toolkit.credentialScheme).toBe("API_KEY");
  });

  it("still calls one no-sign-in when the other mode asks an operator, not the user", async () => {
    // The narrowing must not go too far the other way. A second mode that
    // needs something of whoever set Covan up is not a path a person can take,
    // so it does not make the free one unavailable.
    const toolkit = await detail({
      slug: "SOMETHING",
      name: "Something",
      composio_managed_auth_schemes: [],
      auth_config_details: [
        mode("NO_AUTH", [], []),
        mode("OAUTH2", ["client_id", "client_secret"], ["code"]),
      ],
    });
    expect(toolkit.connectKind).toBe("no_auth");
  });

  it("reads no-sign-in off the column too, which is all a list row carries", async () => {
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [{ slug: "hackernews", name: "HackerNews", no_auth: true }],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits[0]?.connectKind).toBe("no_auth");
  });

  it("admits it cannot say, rather than refusing an application it never looked at", async () => {
    // A catalogue list row proves managed OAuth and no-sign-in and is silent
    // about the rest. Answering `needs_setup` here is how fourteen hundred
    // applications came to be told to go and register an OAuth client.
    const out = await listToolkits(
      ENV,
      {},
      {
        fetchImpl: fetchReturning({
          items: [
            { slug: "posthog", name: "PostHog", auth_schemes: ["API_KEY"], no_auth: false },
            { slug: "gmail", name: "Gmail", composio_managed_auth_schemes: ["OAUTH2"] },
          ],
        }) as never,
      },
    );
    expect(out.kind === "ok" && out.toolkits.map((t) => t.connectKind)).toEqual([
      null,
      "managed_oauth",
    ]);
  });

  it("treats an unreadable requirement as unknown and refuses, never as none", async () => {
    // "Nothing is required" and "we were not told what is required" are both
    // falsy and mean opposite things. The first is an application anyone can
    // connect; the second is one we know nothing about.
    const toolkit = await detail({
      slug: "OPAQUE",
      name: "Opaque",
      auth_config_details: [{ mode: "API_KEY" }],
    });
    expect(toolkit.connectKind).toBe("needs_setup");
  });

  it("counts an absent required list beside a present stage as empty", async () => {
    // A JSON emitter dropping an empty array is a real thing, so this half has
    // to be lenient while the half above stays strict.
    const toolkit = await detail({
      slug: "TERSE",
      name: "Terse",
      auth_config_details: [
        {
          mode: "API_KEY",
          fields: {
            auth_config_creation: {},
            connected_account_initiation: { required: [{ name: "generic_api_key" }] },
          },
        },
      ],
    });
    expect(toolkit).toMatchObject({ connectKind: "user_credential", credentialScheme: "API_KEY" });
  });

  it("keeps the scheme names a toolkit published when only its modes carry them", async () => {
    // The tile's hint is built from `authSchemes`, which the detail endpoint
    // does not publish. Read from one place only, a toolkit opened from the
    // grid would lose the field the grid had.
    const toolkit = await detail({
      slug: "POSTHOG",
      name: "PostHog",
      auth_config_details: [mode("API_KEY", [], ["generic_api_key"])],
    });
    expect(toolkit.authSchemes).toEqual(["API_KEY"]);
  });

  it("carries a page where the credential can be got, when there is one", async () => {
    const toolkit = await detail({
      slug: "STRIPE",
      name: "Stripe",
      auth_config_details: [
        mode("API_KEY", [], ["generic_api_key"], {
          auth_hint_url: "https://dashboard.stripe.com/apikeys",
        }),
      ],
    });
    expect(toolkit.authHintUrl).toBe("https://dashboard.stripe.com/apikeys");
  });

  it("will not hand the browser an address a link should not hold", async () => {
    for (const address of ["javascript:alert(1)", "http://example.com/keys", "not a url", ""]) {
      const toolkit = await detail({
        slug: "SHADY",
        name: "Shady",
        auth_config_details: [mode("API_KEY", [], ["generic_api_key"], { auth_hint_url: address })],
      });
      expect(toolkit.authHintUrl).toBe("");
    }
  });
});

describe("authConfigPlanFor", () => {
  const toolkit = (over: Partial<ComposioToolkit>): ComposioToolkit => ({
    slug: "x",
    name: "X",
    description: "",
    authSchemes: [],
    managedAuth: false,
    noAuth: false,
    connectKind: null,
    credentialScheme: "",
    authHintUrl: "",
    logo: "",
    categories: [],
    ...over,
  });

  it("reads the same two fields the card renders from, and no others", () => {
    // Not a tidiness point. If this consulted a third field there would be a
    // row whose button promises one thing and whose connect builds another.
    //
    // The no-sign-in case is the sharpest version: `managedAuth` is true on
    // this fixture and must not drag the answer to `managed_oauth`. What it
    // gets instead is null plus a yes from `connectsWithoutAccount` — the two
    // questions the route asks in that order, because for this kind null means
    // "nothing to build" rather than "refuse".
    const open = toolkit({ connectKind: "no_auth", managedAuth: true });
    expect(authConfigPlanFor(open)).toBeNull();
    expect(connectsWithoutAccount(open)).toBe(true);
    // And the other three kinds are not that question's business.
    for (const kind of ["managed_oauth", "user_credential", "needs_setup"] as const) {
      expect(connectsWithoutAccount(toolkit({ connectKind: kind })), kind).toBe(false);
    }
    expect(
      authConfigPlanFor(toolkit({ connectKind: "managed_oauth", credentialScheme: "API_KEY" })),
    ).toEqual({ kind: "managed_oauth" });
    expect(
      authConfigPlanFor(toolkit({ connectKind: "user_credential", credentialScheme: "BASIC" })),
    ).toEqual({ kind: "user_credential", scheme: "BASIC" });
  });

  it("has no plan for an application somebody must set up first", () => {
    expect(authConfigPlanFor(toolkit({ connectKind: "needs_setup" }))).toBeNull();
  });

  it("has no plan for a row that could not say, so a caller cannot guess one", () => {
    expect(authConfigPlanFor(toolkit({ connectKind: null, managedAuth: true }))).toBeNull();
  });

  it("refuses a credential plan with no scheme rather than posting a guess", () => {
    // The guess would be a durable auth config of the wrong kind.
    expect(authConfigPlanFor(toolkit({ connectKind: "user_credential" }))).toBeNull();
  });
});

describe("allowedLogoUrl", () => {
  it("admits the two hosts Composio serves marks from, over HTTPS", () => {
    expect(allowedLogoUrl("https://logos.composio.dev/api/gmail")?.hostname).toBe(
      "logos.composio.dev",
    );
    expect(allowedLogoUrl("https://assets.composio.dev/logos/gmail.png")?.hostname).toBe(
      "assets.composio.dev",
    );
  });

  it("refuses everything else, because this is what stops an open proxy", () => {
    for (const address of [
      "",
      "not a url",
      "http://logos.composio.dev/api/gmail",
      "https://logos.composio.dev.evil.example.com/x.png",
      "https://evil.example.com/x.png",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "//logos.composio.dev/api/gmail",
    ]) {
      expect(allowedLogoUrl(address), address).toBeNull();
    }
  });
});

describe("listToolkitCategories", () => {
  it("reads the headings rather than hard-coding a list that goes stale", async () => {
    const out = await listToolkitCategories(ENV, {
      fetchImpl: fetchReturning({
        items: [
          { id: "CRM", name: "CRM" },
          { id: "crm", name: "Duplicate" },
          { name: "No id at all" },
        ],
      }) as never,
    });
    expect(out).toEqual({ kind: "ok", categories: [{ id: "crm", name: "CRM" }] });
  });
});

describe("statusOf", () => {
  it("maps Composio's vocabulary onto tool_connections.status", async () => {
    expect(statusOf("ACTIVE")).toBe("active");
    expect(statusOf("FAILED")).toBe("failed");
    expect(statusOf("EXPIRED")).toBe("failed");
    // Anything unrecognised stays pending, which is the forgiving direction: a
    // new status name should leave a half-finished connection polling rather
    // than mark a live grant broken.
    expect(statusOf("SOMETHING_NEW")).toBe("pending");
    expect(statusOf("")).toBe("pending");

    const asked = await getConnectedAccount(ENV, "ca_1", {
      fetchImpl: fetchReturning({ data: { status: "ACTIVE" } }) as never,
    });
    expect(asked).toMatchObject({ kind: "ok", status: "active" });
  });
});
