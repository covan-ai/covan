import { describe, it, expect, vi } from "vitest";
import {
  composioConfigured,
  createLink,
  executeTool,
  getConnectedAccount,
  listToolkits,
  searchTools,
  statusOf,
  type ComposioEnv,
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

  it("reuses an auth config the provider already has", async () => {
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_existing", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, LINKED],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1" },
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
      { toolkit: "gmail", userId: "cu_1" },
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

  it("ignores an auth config for another provider, whatever the filter did", async () => {
    // An API that ignores a filter it does not know returns everything, and the
    // first row of everything is somebody else's OAuth application.
    const { impl, calls } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_slack", toolkit: { slug: "slack" } }] }],
      [/auth_configs$/, { auth_config: { id: "ac_gmail" } }],
      [/connected_accounts\/link/, LINKED],
    ]);
    await createLink(ENV, { toolkit: "gmail", userId: "cu_1" }, { fetchImpl: impl as never });
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
      { toolkit: "obscure", userId: "cu_1" },
      {
        fetchImpl: impl as never,
      },
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("Composio's dashboard");
  });

  it("refuses a link answer missing either half", async () => {
    // A link with no account id produces a row that cannot be polled and cannot
    // be revoked — the exact shape `lib/composio/revoke.ts` exists to prevent.
    const { impl } = sequenced([
      [/auth_configs\?/, { items: [{ id: "ac_1", toolkit: { slug: "gmail" } }] }],
      [/connected_accounts\/link/, { redirect_url: "https://consent.test/x" }],
    ]);
    const out = await createLink(
      ENV,
      { toolkit: "gmail", userId: "cu_1" },
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
