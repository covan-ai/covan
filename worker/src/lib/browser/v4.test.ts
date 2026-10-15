import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserEnv } from "./client";
import {
  V4_BASE,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  RUN_COST_CAP_USD,
  createRun,
  modelParamsFor,
  reasoningOf,
  runStatus,
  runSummary,
  runEvents,
  cancelRun,
  browsersFor,
  isTerminalRun,
} from "./v4";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as BrowserEnv;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const BROWSER_ID = "44444444-4444-4444-8444-444444444444";

// Fakes that must never come out of this file's functions.
const LIVE_URL = "https://live.browser-use.test/?wss=secret-live-token";
const CDP_URL = "https://cdp.browser-use.test/devtools/browser/secret-cdp-token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("createRun", () => {
  const created = {
    id: RUN_ID,
    status: "queued",
    sessionId: SESSION_ID,
    model: "m",
    eventsUrl: "/e",
  };

  it("posts to v4 /runs with the key header, and returns the provider's ids", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    const result = await createRun(ENV, { task: "get the pricing", maxCostUsd: RUN_COST_CAP_USD });
    expect(result).toEqual({
      kind: "ok",
      value: { id: RUN_ID, sessionId: SESSION_ID, status: "queued" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs`);
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers["X-Browser-Use-API-Key"]).toBe("bu_test");
  });

  it("sends only task, model and maxCostUsd for a first run with nothing else", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "get the pricing", maxCostUsd: 0.25 });
    // The provider rejects unknown keys and null keys are noise: absent means absent.
    expect(sentBody()).toEqual({ task: "get the pricing", model: DEFAULT_MODEL, maxCostUsd: 0.25 });
  });

  it("always carries maxCostUsd", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", maxCostUsd: RUN_COST_CAP_USD });
    expect(sentBody().maxCostUsd).toBe(RUN_COST_CAP_USD);
  });

  it("carries sessionId for a follow-up, and omits it for a first run", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", sessionId: SESSION_ID, maxCostUsd: 0.25 });
    expect(sentBody().sessionId).toBe(SESSION_ID);

    fetchMock.mockClear();
    await createRun(ENV, { task: "t", maxCostUsd: 0.25 });
    expect("sessionId" in sentBody()).toBe(false);
  });

  it("puts profileId, proxyCountryCode and customProxy inside browserSettings", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, {
      task: "t",
      profileId: PROFILE_ID,
      proxyCountryCode: "de",
      customProxy: { host: "proxy.example", port: 8080, username: "u", password: "p" },
      maxCostUsd: 0.25,
    });
    const body = sentBody();
    expect(body.browserSettings).toEqual({
      profileId: PROFILE_ID,
      proxyCountryCode: "de",
      customProxy: { host: "proxy.example", port: 8080, username: "u", password: "p" },
    });
    expect("profileId" in body).toBe(false);
    expect("proxyCountryCode" in body).toBe(false);
    expect("customProxy" in body).toBe(false);
  });

  /**
   * Ruling R38: a run carrying a shared login must not run in a browser that
   * has the person's profile, and the provider's way to say so on a follow-up
   * is an explicit `profileId: null` — "null vs a profiled browser declines
   * reuse and provisions fresh". So `null` is sent as `null`, not dropped.
   */
  it("sends an explicit null profileId, which declines a profiled browser", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", sessionId: SESSION_ID, profileId: null, maxCostUsd: 0.25 });
    const settings = sentBody().browserSettings as Record<string, unknown>;
    expect(settings).toEqual({ profileId: null });
  });

  it("omits browserSettings entirely when none of its fields is given", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", maxCostUsd: 0.25 });
    expect("browserSettings" in sentBody()).toBe(false);
  });

  it("passes an explicit null proxyCountryCode through, which means 'no proxy'", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", proxyCountryCode: null, maxCostUsd: 0.25 });
    expect(sentBody().browserSettings).toEqual({ proxyCountryCode: null });
  });

  it("omits absent customProxy fields rather than sending nulls", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, {
      task: "t",
      customProxy: { host: "proxy.example", port: 3128 },
      maxCostUsd: 0.25,
    });
    expect(sentBody().browserSettings).toEqual({
      customProxy: { host: "proxy.example", port: 3128 },
    });
  });

  it("omits secretBindings when absent or empty, and sends them when given", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", maxCostUsd: 0.25 });
    expect("secretBindings" in sentBody()).toBe(false);

    fetchMock.mockClear();
    await createRun(ENV, { task: "t", secretBindings: [], maxCostUsd: 0.25 });
    expect("secretBindings" in sentBody()).toBe(false);

    fetchMock.mockClear();
    const binding = {
      alias: "linkedin_password",
      source: { type: "inline" as const, value: "hunter2" },
      allowedDomains: ["linkedin.com"],
    };
    await createRun(ENV, { task: "t", secretBindings: [binding], maxCostUsd: 0.25 });
    expect(sentBody().secretBindings).toEqual([binding]);
  });

  it("sends outputSchema and model when given, and omits outputSchema otherwise", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", maxCostUsd: 0.25 });
    expect("outputSchema" in sentBody()).toBe(false);

    fetchMock.mockClear();
    const outputSchema = { type: "object", properties: { price: { type: "number" } } };
    await createRun(ENV, { task: "t", outputSchema, model: "gpt-5.6", maxCostUsd: 0.25 });
    expect(sentBody().outputSchema).toEqual(outputSchema);
    expect(sentBody().model).toBe("gpt-5.6");
  });

  it("sends modelParams when given, and omits it otherwise", async () => {
    fetchMock.mockResolvedValue(json(created, 202));
    await createRun(ENV, { task: "t", maxCostUsd: 0.25 });
    expect("modelParams" in sentBody()).toBe(false);

    fetchMock.mockClear();
    const modelParams = { reasoning: { effort: "low" } };
    await createRun(ENV, { task: "t", modelParams, maxCostUsd: 0.25 });
    expect(sentBody().modelParams).toEqual(modelParams);
  });

  /**
   * The request names a profile and the provider's 422 echoes the offending
   * input. That string reaches `message_steps.result_excerpt`, which every
   * member of a shared session can read.
   */
  it("withholds the provider's body on a 422 that echoes a profile id", async () => {
    fetchMock.mockResolvedValue(
      json({ detail: [{ loc: ["body", "browserSettings", "profileId"], input: PROFILE_ID }] }, 422),
    );
    const result = await createRun(ENV, {
      task: "t",
      profileId: PROFILE_ID,
      maxCostUsd: 0.25,
    });
    expect(result.kind).toBe("error");
    expect((result as { status: number }).status).toBe(422);
    expect((result as { message: string }).message).not.toContain(PROFILE_ID);
  });
});

describe("modelParamsFor", () => {
  it("spells the effort the way each family takes it", () => {
    expect(modelParamsFor("gpt-5.6-luna", "medium")).toEqual({ reasoning: { effort: "medium" } });
    expect(modelParamsFor("claude-sonnet-5", "low")).toEqual({ output_config: { effort: "low" } });
    expect(modelParamsFor("gemini-3.6-flash", "high")).toEqual({
      thinkingConfig: { thinkingLevel: "high" },
    });
    expect(modelParamsFor("gemini-3.6-flash", "none")).toEqual({
      thinkingConfig: { thinkingLevel: "minimal" },
    });
  });

  /** Each of these would be a 422 on every run. */
  it("sends nothing for a level the family has no word for, or a family it does not know", () => {
    expect(modelParamsFor("claude-opus-5", "none")).toBeUndefined();
    expect(modelParamsFor("gpt-6-astra", "none")).toBeUndefined();
    expect(modelParamsFor("gpt-5.5", "max")).toBeUndefined();
    expect(modelParamsFor("gemini-3.6-flash", "xhigh")).toBeUndefined();
    expect(modelParamsFor("gemini-3.6-flash", "max")).toBeUndefined();
    expect(modelParamsFor("minimax-m3", "medium")).toBeUndefined();
    expect(modelParamsFor("grok-4.5", "low")).toBeUndefined();
  });
});

describe("reasoningOf", () => {
  it("is the default when unset, empty or a word it does not know", () => {
    expect(reasoningOf(undefined)).toBe(DEFAULT_REASONING);
    expect(reasoningOf("")).toBe(DEFAULT_REASONING);
    expect(reasoningOf("extreme")).toBe(DEFAULT_REASONING);
  });

  it("reads a level, case and whitespace aside", () => {
    expect(reasoningOf("low")).toBe("low");
    expect(reasoningOf(" XHigh ")).toBe("xhigh");
  });

  it("is null for `provider`, which sends no modelParams", () => {
    expect(reasoningOf("provider")).toBeNull();
  });
});

describe("runStatus", () => {
  it("reads the cheap status endpoint", async () => {
    fetchMock.mockResolvedValue(json({ status: "running" }));
    const result = await runStatus(ENV, RUN_ID);
    expect(result).toEqual({ kind: "ok", value: { status: "running" } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs/${RUN_ID}/status`);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it.each(["queued", "dispatching", "running", "completed", "failed", "cancelled"])(
    "accepts %s as the provider's word",
    async (status) => {
      fetchMock.mockResolvedValue(json({ status }));
      expect(await runStatus(ENV, RUN_ID)).toEqual({ kind: "ok", value: { status } });
    },
  );

  it("reads a status word it has not met as running, so the poller comes back later", async () => {
    fetchMock.mockResolvedValue(json({ status: "paused" }));
    expect(await runStatus(ENV, RUN_ID)).toEqual({ kind: "ok", value: { status: "running" } });
  });

  it("redacts the body on failure", async () => {
    fetchMock.mockResolvedValue(json({ detail: `run ${RUN_ID} not found` }, 404));
    const result = await runStatus(ENV, RUN_ID);
    expect((result as { message: string }).message).not.toContain(RUN_ID);
    expect((result as { status: number }).status).toBe(404);
  });
});

describe("isTerminalRun", () => {
  it("is true for exactly completed, failed and cancelled", () => {
    expect(isTerminalRun("completed")).toBe(true);
    expect(isTerminalRun("failed")).toBe(true);
    expect(isTerminalRun("cancelled")).toBe(true);
    expect(isTerminalRun("queued")).toBe(false);
    expect(isTerminalRun("dispatching")).toBe(false);
    expect(isTerminalRun("running")).toBe(false);
  });
});

describe("runSummary", () => {
  it("parses the string cost, and carries result, error, output and the session", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: RUN_ID,
        task: "t",
        status: "completed",
        result: "the answer",
        output: { price: 12 },
        error: null,
        sessionId: SESSION_ID,
        totalCostUsd: "0.042",
      }),
    );
    const result = await runSummary(ENV, RUN_ID);
    expect(result).toEqual({
      kind: "ok",
      value: {
        id: RUN_ID,
        status: "completed",
        result: "the answer",
        output: { price: 12 },
        error: null,
        totalCostUsd: 0.042,
        sessionId: SESSION_ID,
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs/${RUN_ID}`);
  });

  it("answers null for an unparseable cost, an absent output and an absent result", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: RUN_ID,
        status: "failed",
        error: "boom",
        sessionId: SESSION_ID,
        totalCostUsd: "n/a",
      }),
    );
    const result = await runSummary(ENV, RUN_ID);
    expect(result).toEqual({
      kind: "ok",
      value: {
        id: RUN_ID,
        status: "failed",
        result: null,
        output: null,
        error: "boom",
        totalCostUsd: null,
        sessionId: SESSION_ID,
      },
    });
  });
});

describe("runEvents", () => {
  const ready = {
    runId: RUN_ID,
    id: 7,
    ts: "2026-10-10T10:00:00Z",
    type: "browser.ready",
    data: { browser_session_id: BROWSER_ID, live_view_url: LIVE_URL, cdp_url: CDP_URL },
  };

  it("passes the cursor as `after` and returns the next one", async () => {
    fetchMock.mockResolvedValue(
      json({
        events: [{ runId: RUN_ID, id: 12, ts: "t", type: "step", data: { n: 1 } }],
        nextAfter: 12,
        hasMore: true,
      }),
    );
    const result = await runEvents(ENV, RUN_ID, 5);
    expect(result).toEqual({
      kind: "ok",
      value: {
        events: [{ id: 12, ts: "t", type: "step", data: { n: 1 } }],
        nextAfter: 12,
        hasMore: true,
      },
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(`${V4_BASE}/runs/${RUN_ID}/events`);
    expect(url.searchParams.get("after")).toBe("5");
  });

  it("answers a null cursor and hasMore false when the provider has none", async () => {
    fetchMock.mockResolvedValue(json({ events: [] }));
    const result = await runEvents(ENV, RUN_ID, 0);
    expect(result).toEqual({
      kind: "ok",
      value: { events: [], nextAfter: null, hasMore: false },
    });
  });

  it("keeps browser_session_id from browser.ready and drops both URL fields", async () => {
    fetchMock.mockResolvedValue(json({ events: [ready], nextAfter: 7, hasMore: false }));
    const result = await runEvents(ENV, RUN_ID, 0);
    expect(result.kind).toBe("ok");
    const events = (result as { value: { events: { data: Record<string, unknown> }[] } }).value
      .events;
    expect(events[0].data.browser_session_id).toBe(BROWSER_ID);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(LIVE_URL);
    expect(serialised).not.toContain(CDP_URL);
    expect(serialised).not.toContain("live_view_url");
    expect(serialised).not.toContain("cdp_url");
  });

  it("drops every other field of a browser.reattached event too", async () => {
    fetchMock.mockResolvedValue(
      json({
        events: [
          {
            ...ready,
            type: "browser.reattached",
            data: {
              browser_session_id: BROWSER_ID,
              live_view_url: LIVE_URL,
              cdp_url: CDP_URL,
              debugger_url: "https://other.example/debug?token=abc",
            },
          },
        ],
      }),
    );
    const result = await runEvents(ENV, RUN_ID, 0);
    const serialised = JSON.stringify(result);
    expect(serialised).toContain(BROWSER_ID);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("other.example");
  });

  /**
   * Task 3.4: real runs announce the browser twice, `browser.attached` before
   * `browser.ready`, and the first carries `live_view_url` too. It is on the
   * allowlist with the other two rather than left to the denylist.
   */
  it("keeps only browser_session_id from browser.attached as well", async () => {
    fetchMock.mockResolvedValue(
      json({
        events: [
          {
            ...ready,
            type: "browser.attached",
            data: {
              browser_session_id: BROWSER_ID,
              live_view_url: LIVE_URL,
              cdp_url_present: true,
              viewer_link: "https://other.example/view?token=abc",
            },
          },
        ],
      }),
    );
    const result = await runEvents(ENV, RUN_ID, 0);
    const events = (result as { value: { events: { data: Record<string, unknown> }[] } }).value
      .events;
    expect(events[0].data).toEqual({ browser_session_id: BROWSER_ID });
  });

  it("strips a live or cdp URL field from any other event type as well", async () => {
    fetchMock.mockResolvedValue(
      json({
        events: [
          {
            runId: RUN_ID,
            id: 1,
            ts: "t",
            type: "something.else",
            data: { text: "hello", live_view_url: LIVE_URL, nested: { cdp_url: CDP_URL, ok: 1 } },
          },
        ],
      }),
    );
    const result = await runEvents(ENV, RUN_ID, 0);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(LIVE_URL);
    expect(serialised).not.toContain(CDP_URL);
    expect(serialised).toContain("hello");
  });
});

describe("cancelRun", () => {
  it("posts to /cancel and reads the status from the summary it answers", async () => {
    fetchMock.mockResolvedValue(json({ id: RUN_ID, status: "cancelled", sessionId: SESSION_ID }));
    const result = await cancelRun(ENV, RUN_ID);
    expect(result).toEqual({ kind: "ok", value: { status: "cancelled" } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs/${RUN_ID}/cancel`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });
});

describe("browsersFor", () => {
  it("lists a session's browsers as id and status, and carries no URL", async () => {
    fetchMock.mockResolvedValue(
      json({
        items: [
          { id: BROWSER_ID, status: "active", liveUrl: LIVE_URL, cdpUrl: CDP_URL },
          { id: "b-2", status: "stopped", liveUrl: null, cdpUrl: null },
        ],
        totalItems: 2,
        pageNumber: 1,
        pageSize: 10,
      }),
    );
    const result = await browsersFor(ENV, SESSION_ID);
    expect(result).toEqual({
      kind: "ok",
      value: [
        { id: BROWSER_ID, status: "active" },
        { id: "b-2", status: "stopped" },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/browsers?agentSessionId=${SESSION_ID}`);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("the v4 base URL", () => {
  const okBody = { id: RUN_ID, status: "queued", sessionId: SESSION_ID };

  it("honours BROWSER_USE_V4_BASE_URL, trimming trailing slashes", async () => {
    fetchMock.mockResolvedValue(json(okBody, 202));
    await createRun(
      { ...ENV, BROWSER_USE_V4_BASE_URL: "https://bu.internal/api/v4//" },
      { task: "t", maxCostUsd: 0.25 },
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://bu.internal/api/v4/runs");
  });

  it("treats an empty BROWSER_USE_V4_BASE_URL as no override", async () => {
    fetchMock.mockResolvedValue(json(okBody, 202));
    await createRun({ ...ENV, BROWSER_USE_V4_BASE_URL: "" }, { task: "t", maxCostUsd: 0.25 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs`);
  });

  it("is not moved by BROWSER_USE_BASE_URL, which stays v2's", async () => {
    fetchMock.mockResolvedValue(json(okBody, 202));
    await createRun(
      { ...ENV, BROWSER_USE_BASE_URL: "https://bu.internal/api/v2" },
      { task: "t", maxCostUsd: 0.25 },
    );
    expect(fetchMock.mock.calls[0][0]).toBe(`${V4_BASE}/runs`);
  });

  it("answers 501 without a key, like every other call", async () => {
    const result = await runStatus({} as BrowserEnv, RUN_ID);
    expect(result.kind).toBe("error");
    expect((result as { status: number }).status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
