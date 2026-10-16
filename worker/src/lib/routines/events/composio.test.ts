import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";

vi.mock("../../supabase", () => ({
  serviceClient: () => {
    throw new Error("a test must hand in its own db");
  },
}));

const client = vi.hoisted(() => ({
  upsertTriggerInstance: vi.fn(),
  setTriggerStatus: vi.fn(),
  deleteTriggerInstance: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock("../../composio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../composio/client")>()),
  ...client,
}));

const record = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../entitlements", () => ({
  entitlementsFor: () => ({ record }),
}));

const { composioAdapter, cancelOrphanTrigger } = await import("./composio");
const { EventSourceError } = await import("./errors");

const ENV = {
  COMPOSIO_API_KEY: "ck",
  COMPOSIO_WEBHOOK_SECRET: "whs",
  RESEND_FROM: "Covan Routines <routines@covan.example>",
} as RoutineEnv;

const connection = (over: Row = {}): Row => ({
  id: "tc1",
  workspace_id: "w1",
  created_by: "u1",
  scope: "owner",
  status: "active",
  transport: "composio",
  toolkit_slug: "gmail",
  connected_account_id: "ca_1",
  composio_user_id: "cu_1",
  ...over,
});

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  routine_id: "r1",
  provider: "composio",
  event_type: "gmail.new_message",
  config: { connectionId: "tc1" },
  external_id: null,
  secret_ciphertext: null,
  state: {},
  status: "pending",
  status_detail: null,
  expires_at: null,
  attempts: 0,
  ...over,
});

function setup(rows: { connections?: Row[]; subs?: Row[] } = {}) {
  const db = memoryDb({
    tool_connections: rows.connections ?? [connection()],
    routine_event_subscriptions: rows.subs ?? [],
  });
  const adapter = composioAdapter({ db: () => db.db as unknown as SupabaseClient });
  const ctx = (s: SubscriptionRow, eventType = "gmail.new_message"): AdapterContext => ({
    env: ENV,
    routine: { id: s.routine_id, user_id: "u1", workspace_id: "w1" },
    subscription: s,
    eventType: CATALOGUE.eventType(eventType)!,
    secret: null,
  });
  return { db, adapter, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.upsertTriggerInstance.mockResolvedValue({ kind: "ok", triggerId: "ti_new" });
  client.setTriggerStatus.mockResolvedValue({ kind: "ok", body: "" });
  client.deleteTriggerInstance.mockResolvedValue({ kind: "ok", body: "" });
});

describe("isConfigured", () => {
  it("needs both the API key and the webhook secret, on whichever Worker asks", () => {
    const { adapter } = setup();
    expect(adapter.isConfigured(ENV)).toBe(true);
    expect(adapter.isConfigured({ ...ENV, COMPOSIO_WEBHOOK_SECRET: undefined })).toBe(false);
    expect(adapter.isConfigured({ ...ENV, COMPOSIO_API_KEY: undefined })).toBe(false);
  });
});

describe("subscribe", () => {
  it("makes the trigger on the recorded connection's own account, with the entry's config", async () => {
    const { adapter, ctx } = setup();
    const out = await adapter.subscribe(
      ctx(sub({ config: { connectionId: "tc1", query: "from:a@b.c" } })),
    );
    expect(client.upsertTriggerInstance).toHaveBeenCalledWith(ENV, {
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      connectedAccountId: "ca_1",
      userId: "cu_1",
      triggerConfig: { query: "from:a@b.c" },
    });
    expect(out).toEqual({
      externalId: "ti_new",
      state: { connectedAccountId: "ca_1", composioUserId: "cu_1" },
    });
  });

  it.each([
    ["missing", []],
    ["in another workspace", [connection({ workspace_id: "w2" })]],
    ["somebody else's personal one", [connection({ created_by: "u2" })]],
    ["not active", [connection({ status: "failed" })]],
    ["for another app", [connection({ toolkit_slug: "outlook" })]],
    ["without an account", [connection({ connected_account_id: null })]],
  ])("refuses a connection that is %s, as expired, and makes nothing", async (_, connections) => {
    const { adapter, ctx } = setup({ connections });
    const err = await adapter.subscribe(ctx(sub())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventSourceError);
    expect((err as InstanceType<typeof EventSourceError>).expired).toBe(true);
    expect((err as Error).message).toMatch(/^Gmail is no longer connected/);
    expect(client.upsertTriggerInstance).not.toHaveBeenCalled();
  });

  it("subscribes through a colleague's connection they shared with the workspace", async () => {
    const { adapter, ctx } = setup({
      connections: [connection({ created_by: "u2", scope: "workspace" })],
    });
    await expect(adapter.subscribe(ctx(sub()))).resolves.toMatchObject({ externalId: "ti_new" });
  });

  it("says what the app refused, so the person can fix it", async () => {
    client.upsertTriggerInstance.mockResolvedValue({
      kind: "error",
      status: 400,
      message: "Invalid query",
    });
    const { adapter, ctx } = setup();
    const err = await adapter.subscribe(ctx(sub())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventSourceError);
    expect((err as Error).message).toContain("Gmail refused these settings: Invalid query");
  });

  it("leaves Composio being down to the retry, not to the person", async () => {
    client.upsertTriggerInstance.mockResolvedValue({ kind: "error", status: 503, message: "down" });
    const { adapter, ctx } = setup();
    const err = await adapter.subscribe(ctx(sub())).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EventSourceError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("a trigger shared by two routines", () => {
  const mine = sub({ external_id: "ti_shared", status: "active" });
  const theirs = (status: string): Row => ({
    ...sub({ routine_id: "r2", external_id: "ti_shared" }),
    status,
  });

  it("is deleted only when nobody else holds it", async () => {
    const alone = setup({ subs: [mine as unknown as Row] });
    await alone.adapter.unsubscribe(alone.ctx(mine));
    expect(client.deleteTriggerInstance).toHaveBeenCalledWith(ENV, "ti_shared");

    vi.clearAllMocks();
    const shared = setup({ subs: [mine as unknown as Row, theirs("active")] });
    await shared.adapter.unsubscribe(shared.ctx(mine));
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
    expect(client.setTriggerStatus).not.toHaveBeenCalled();
  });

  it("is paused, not deleted, when its other holder is not listening either", async () => {
    const { adapter, ctx } = setup({ subs: [mine as unknown as Row, theirs("disabled")] });
    await adapter.unsubscribe(ctx(mine));
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
    expect(client.setTriggerStatus).toHaveBeenCalledWith(ENV, "ti_shared", false);
  });

  it("is not paused while another routine is listening to it", async () => {
    const { adapter, ctx } = setup({ subs: [mine as unknown as Row, theirs("active")] });
    await adapter.setEnabled(ctx(mine), false);
    expect(client.setTriggerStatus).not.toHaveBeenCalled();
  });

  it("is paused when the last listener pauses", async () => {
    const { adapter, ctx } = setup({ subs: [mine as unknown as Row, theirs("disabled")] });
    await adapter.setEnabled(ctx(mine), false);
    expect(client.setTriggerStatus).toHaveBeenCalledWith(ENV, "ti_shared", false);
  });
});

describe("setEnabled(true)", () => {
  it("subscribes again, which brings back a disabled instance or makes a lost one", async () => {
    const { adapter, ctx } = setup();
    const out = await adapter.setEnabled(
      ctx(sub({ external_id: "ti_old", status: "disabled" })),
      true,
    );
    expect(client.upsertTriggerInstance).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ externalId: "ti_new" });
  });
});

describe("normalize", () => {
  const active = sub({
    external_id: "ti_1",
    status: "active",
    state: { connectedAccountId: "ca_1", composioUserId: "cu_1" },
  });
  const delivery = (data: Record<string, unknown>, account = "ca_1") => ({
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: "ti_1", connected_account_id: account },
    data,
  });

  it("describes a delivery on the account it was subscribed with", async () => {
    const { adapter, ctx } = setup();
    const out = await adapter.normalize(
      delivery({ message_id: "m1", sender: "a@b.c", subject: "Hi", message_text: "Hello" }),
      ctx(active),
    );
    expect(out).toMatchObject({ eventId: "gmail:m1" });
    expect(out?.text).toContain("Hello");
  });

  it("drops a delivery that names another account", async () => {
    const { adapter, ctx } = setup();
    expect(
      await adapter.normalize(delivery({ message_id: "m1" }, "ca_someone_else"), ctx(active)),
    ).toBeNull();
  });

  it("drops the routine's own mail coming back round", async () => {
    const { adapter, ctx } = setup();
    expect(
      await adapter.normalize(
        delivery({ message_id: "m2", sender: "Covan Routines <routines@covan.example>" }),
        ctx(active),
      ),
    ).toBeNull();
  });

  it("drops a delivery with no data", async () => {
    const { adapter, ctx } = setup();
    expect(await adapter.normalize({ type: "composio.trigger.message" }, ctx(active))).toBeNull();
  });

  it("fetches what an Outlook delivery left out on the same account, and bills the lookup", async () => {
    client.executeTool.mockResolvedValue({
      kind: "ok",
      body: JSON.stringify({
        data: { subject: "Invoice", body: { contentType: "text", content: "Due" } },
      }),
    });
    const { adapter, ctx } = setup();
    const outlook = { ...active, event_type: "outlook.new_message" };
    const out = await adapter.normalize(
      delivery({ id: "AAMk" }),
      ctx(outlook, "outlook.new_message"),
    );
    expect(client.executeTool).toHaveBeenCalledWith(ENV, {
      slug: "OUTLOOK_GET_MESSAGE",
      connectedAccountId: "ca_1",
      userId: "cu_1",
      arguments: expect.objectContaining({ message_id: "AAMk" }),
    });
    expect(record).toHaveBeenCalledWith(
      "w1",
      [{ kind: "composio_call", toolSlug: "OUTLOOK_GET_MESSAGE" }],
      {
        userId: "u1",
      },
    );
    expect(out?.text).toContain("Subject: Invoice");
  });

  it("still describes an Outlook delivery when the lookup fails, and bills nothing unsent", async () => {
    client.executeTool.mockResolvedValue({ kind: "error", status: 502, message: "unreachable" });
    const { adapter, ctx } = setup();
    const outlook = { ...active, event_type: "outlook.new_message" };
    const out = await adapter.normalize(
      delivery({ id: "AAMk" }),
      ctx(outlook, "outlook.new_message"),
    );
    expect(out?.eventId).toBe("outlook:AAMk");
    expect(record).not.toHaveBeenCalled();
  });
});

describe("cancelOrphanTrigger", () => {
  const dbWith = (subs: Row[]) =>
    memoryDb({ routine_event_subscriptions: subs }).db as unknown as SupabaseClient;

  it("ends a trigger nothing is waiting for", async () => {
    await cancelOrphanTrigger(ENV, "ti_orphan", { db: dbWith([]) });
    expect(client.deleteTriggerInstance).toHaveBeenCalledWith(ENV, "ti_orphan");
  });

  it("leaves it alone while a subscribe may be in flight", async () => {
    await cancelOrphanTrigger(ENV, "ti_orphan", {
      db: dbWith([sub({ routine_id: "r9", status: "pending" }) as unknown as Row]),
    });
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
  });

  it("leaves it alone when a row does hold it after all", async () => {
    await cancelOrphanTrigger(ENV, "ti_held", {
      db: dbWith([sub({ external_id: "ti_held", status: "active" }) as unknown as Row]),
    });
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
  });

  it("refuses an id that is not shaped like one, before it reaches a filter", async () => {
    await cancelOrphanTrigger(ENV, "ti_1,status.eq.active", { db: dbWith([]) });
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
  });
});
