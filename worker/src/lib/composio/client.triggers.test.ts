import { describe, it, expect, vi } from "vitest";
import {
  deleteTriggerInstance,
  ensureWebhookSubscription,
  getTriggerType,
  setTriggerStatus,
  upsertTriggerInstance,
  type ComposioEnv,
} from "./client";

const ENV: ComposioEnv = { COMPOSIO_API_KEY: "ck_test" };

function fetchReturning(...answers: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  });
}

describe("upsertTriggerInstance", () => {
  it("names the account and the config, and answers Composio's trigger_id", async () => {
    const fetchImpl = fetchReturning({ body: { trigger_id: "ti_abc" }, status: 201 });
    const out = await upsertTriggerInstance(
      ENV,
      {
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        connectedAccountId: "ca_1",
        userId: "cu_1",
        triggerConfig: { query: "from:a@b.c" },
      },
      { fetchImpl: fetchImpl as never },
    );
    expect(out).toEqual({ kind: "ok", triggerId: "ti_abc" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://backend.composio.dev/api/v3/trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      connected_account_id: "ca_1",
      user_id: "cu_1",
      trigger_config: { query: "from:a@b.c" },
    });
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("ck_test");
  });

  it("treats an answer with no id as a failure, not as a trigger", async () => {
    const out = await upsertTriggerInstance(
      ENV,
      { slug: "X", connectedAccountId: "ca", userId: "u", triggerConfig: {} },
      { fetchImpl: fetchReturning({ body: {} }) as never },
    );
    expect(out).toMatchObject({ kind: "error", status: 502 });
  });

  it("passes Composio's own refusal through", async () => {
    const out = await upsertTriggerInstance(
      ENV,
      { slug: "X", connectedAccountId: "ca", userId: "u", triggerConfig: {} },
      {
        fetchImpl: fetchReturning({
          body: { error: { message: "calendarId not found" } },
          status: 400,
        }) as never,
      },
    );
    expect(out).toMatchObject({ kind: "error", status: 400 });
    expect(out.kind === "error" && out.message).toContain("calendarId not found");
  });

  it("refuses without a key, before any request", async () => {
    const fetchImpl = fetchReturning({ body: {} });
    const out = await upsertTriggerInstance(
      {},
      { slug: "X", connectedAccountId: "ca", userId: "u", triggerConfig: {} },
      { fetchImpl: fetchImpl as never },
    );
    expect(out).toMatchObject({ kind: "error", status: 501 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("setTriggerStatus", () => {
  it("sends enable or disable to the manage path", async () => {
    const fetchImpl = fetchReturning({ body: { status: "success" } });
    await setTriggerStatus(ENV, "ti_1", false, { fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://backend.composio.dev/api/v3/trigger_instances/manage/ti_1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "disable" });
  });

  it("takes 'already in that state' as done", async () => {
    const out = await setTriggerStatus(ENV, "ti_1", true, {
      fetchImpl: fetchReturning({
        body: { error: { message: "already enabled" } },
        status: 409,
      }) as never,
    });
    expect(out.kind).toBe("ok");
  });
});

describe("deleteTriggerInstance", () => {
  it.each([404, 409, 410])("takes %s — already gone — as done", async (status) => {
    const out = await deleteTriggerInstance(ENV, "ti_1", {
      fetchImpl: fetchReturning({ body: { error: { message: "gone" } }, status }) as never,
    });
    expect(out.kind).toBe("ok");
  });

  it("reports a real failure", async () => {
    const out = await deleteTriggerInstance(ENV, "ti_1", {
      fetchImpl: fetchReturning({ body: { error: { message: "boom" } }, status: 500 }) as never,
    });
    expect(out).toMatchObject({ kind: "error", status: 500 });
  });
});

describe("getTriggerType", () => {
  it("reads the slug, its type and its config schema", async () => {
    const out = await getTriggerType(ENV, "GMAIL_NEW_GMAIL_MESSAGE", {
      fetchImpl: fetchReturning({
        body: {
          slug: "GMAIL_NEW_GMAIL_MESSAGE",
          type: "poll",
          config: { properties: { query: { type: "string" } } },
        },
      }) as never,
    });
    expect(out).toEqual({
      kind: "ok",
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      type: "poll",
      config: { properties: { query: { type: "string" } } },
    });
  });
});

describe("ensureWebhookSubscription", () => {
  const want = {
    webhookUrl: "https://api.example.com/composio/events",
    enabledEvents: ["composio.trigger.message"],
  };

  it("creates the project's subscription when there is none", async () => {
    const fetchImpl = fetchReturning(
      { body: { items: [] } },
      {
        body: {
          id: "whs_1",
          webhook_url: want.webhookUrl,
          enabled_events: want.enabledEvents,
          version: "V3",
          secret: "s3cret",
        },
        status: 201,
      },
    );
    const out = await ensureWebhookSubscription(ENV, want, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "ok", created: true, subscription: { secret: "s3cret" } });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://backend.composio.dev/api/v3/webhook_subscriptions");
    expect(JSON.parse(String(init?.body))).toEqual({
      webhook_url: want.webhookUrl,
      enabled_events: want.enabledEvents,
      version: "V3",
    });
  });

  it("updates the one that exists rather than making a second, which Composio refuses", async () => {
    const fetchImpl = fetchReturning(
      { body: { items: [{ id: "whs_1", secret: "kept", webhook_url: "https://old" }] } },
      { body: { id: "whs_1", webhook_url: want.webhookUrl, enabled_events: [] } },
    );
    const out = await ensureWebhookSubscription(ENV, want, { fetchImpl: fetchImpl as never });
    expect(out).toMatchObject({ kind: "ok", created: false, subscription: { secret: "kept" } });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://backend.composio.dev/api/v3/webhook_subscriptions/whs_1");
    expect(init?.method).toBe("PATCH");
  });
});
