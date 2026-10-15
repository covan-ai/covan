import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import type { EventAdapter, EventRegistry } from "./adapter";
import { catalogueOf, type EventTypeDef } from "./catalog";

vi.mock("../../supabase", () => ({
  serviceClient: () => {
    throw new Error("a test must hand in its own db");
  },
}));
// The real run and pause build executor deps; these tests only need to see
// that they would have been called, and with what.
vi.mock("../dispatcher", () => ({ runPokedRoutine: vi.fn(), pauseForEventFlood: vi.fn() }));

const { receiveEvent, eventRunLimits, DEFAULT_EVENT_RUNS_PER_HOUR } = await import("./receive");

const ENV = { ROUTINE_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } as RoutineEnv;

const MAIL: EventTypeDef = {
  id: "mail.new",
  provider: "composio",
  app: "Mail",
  label: "New mail",
  description: "A mail arrives.",
  requires: { kind: "none" },
  config: z.object({ from: z.string().optional() }),
  fields: [],
  // A filter the provider could not apply, applied here.
  matches: (config, event) => !config.from || event.fields?.sender === config.from,
  sample: { eventId: "sample", text: "From: someone" },
};

const routine = (over: Row = {}): Row => ({
  id: "r1",
  agent_id: "a1",
  user_id: "u1",
  workspace_id: "w1",
  name: "Inbox",
  source_kind: "none",
  status: "active",
  trigger_kind: "event",
  deleted_at: null,
  ...over,
});

const subscription = (over: Row = {}): Row => ({
  routine_id: "r1",
  provider: "composio",
  event_type: "mail.new",
  config: {},
  external_id: "ti_1",
  secret_ciphertext: null,
  state: {},
  status: "active",
  status_detail: null,
  expires_at: null,
  attempts: 0,
  ...over,
});

let normalize: ReturnType<typeof vi.fn>;
let verdict: string;
let deferred: Promise<unknown>[];
let run: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let sync: ReturnType<typeof vi.fn>;
let rpc: ReturnType<typeof vi.fn>;

function registry(): EventRegistry {
  const adapter: EventAdapter = {
    provider: "composio",
    isConfigured: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    setEnabled: vi.fn(),
    normalize: normalize as unknown as EventAdapter["normalize"],
  };
  return { ...catalogueOf([MAIL]), adapterFor: (p) => (p === "composio" ? adapter : undefined) };
}

function receive(
  rows: { routines?: Row[]; subs?: Row[] } = {},
  target: Parameters<typeof receiveEvent>[1] = { provider: "composio", externalId: "ti_1" },
  env: RoutineEnv = ENV,
) {
  const m = memoryDb({
    routines: rows.routines ?? [routine()],
    routine_event_subscriptions: rows.subs ?? [subscription()],
  });
  (m.db as unknown as { rpc: unknown }).rpc = rpc;
  return receiveEvent(
    env,
    target,
    { raw: true },
    {
      db: m.db as unknown as SupabaseClient,
      registry: registry(),
      defer: (p) => deferred.push(p),
      run: run as never,
      pause: pause as never,
      sync: sync as never,
    },
  );
}

beforeEach(() => {
  normalize = vi.fn(async () => ({
    eventId: "msg_1",
    text: "From: Ayşe\nSubject: Thursday",
    fields: { sender: "ayse@example.com" },
  }));
  verdict = "ok";
  deferred = [];
  run = vi.fn(async () => ({ status: "ok", itemsNew: 1 }));
  pause = vi.fn(async () => true);
  sync = vi.fn(async () => ({ status: "disabled", detail: null }));
  rpc = vi.fn(async () => ({ data: verdict, error: null }));
});

describe("receiveEvent", () => {
  it("runs the routine on the adapter's account of the event, keyed by provider", async () => {
    const out = await receive();

    expect(out).toEqual({ status: "accepted", eventId: "composio:msg_1" });
    expect(deferred).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    const [, ran, trigger] = run.mock.calls[0];
    expect(ran.id).toBe("r1");
    expect(trigger).toEqual({
      eventId: "composio:msg_1",
      payload: "From: Ayşe\nSubject: Thursday",
      source: "event",
      label: "Mail · New mail",
    });
  });

  it("finds the subscription by routine when the route's URL named it", async () => {
    const out = await receive({}, { routineId: "r1" });
    expect(out.status).toBe("accepted");
  });

  it("counts the event against the routine's limits before running it", async () => {
    await receive();
    expect(rpc).toHaveBeenCalledWith("count_routine_event", {
      p_routine_id: "r1",
      p_per_hour: DEFAULT_EVENT_RUNS_PER_HOUR,
      p_per_day: 500,
    });
  });

  it("is unknown when no subscription matches, so the route can cancel at the source", async () => {
    expect(await receive({ subs: [] })).toEqual({ status: "unknown" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["a paused routine", { routines: [routine({ status: "paused" })] }],
    ["a binned routine", { routines: [routine({ deleted_at: "2026-10-15T00:00:00Z" })] }],
    [
      "a routine that stopped waiting for events",
      { routines: [routine({ trigger_kind: "schedule" })] },
    ],
    ["a subscription that is not active", { subs: [subscription({ status: "disabled" })] }],
  ])("runs nothing for %s", async (_, rows) => {
    expect(await receive(rows)).toEqual({ status: "inactive" });
    expect(rpc).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs nothing when the adapter says it was not an event for this routine", async () => {
    normalize.mockResolvedValue(null);
    expect(await receive()).toEqual({ status: "ignored" });
    expect(run).not.toHaveBeenCalled();
  });

  // Ahead of the count and the run, so a filtered event costs nothing at all.
  it("runs nothing, and counts nothing, for an event the filter refuses", async () => {
    const out = await receive({ subs: [subscription({ config: { from: "boss@example.com" } })] });

    expect(out).toEqual({ status: "filtered" });
    expect(rpc).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs one the filter accepts", async () => {
    const out = await receive({ subs: [subscription({ config: { from: "ayse@example.com" } })] });
    expect(out.status).toBe("accepted");
  });

  it("pauses the routine and stops the provider when the hour's limit is crossed", async () => {
    verdict = "hour";

    const out = await receive();
    await Promise.all(deferred);

    expect(out).toEqual({ status: "flood" });
    expect(run).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
    expect(pause.mock.calls[0][2]).toBe("more than 60 events arrived within an hour.");
    expect(sync).toHaveBeenCalledWith(ENV, "r1", expect.anything());
  });

  // Several events cross the limit together; only the one that actually
  // paused the routine tells the provider, and only it mailed the owner.
  it("leaves the provider alone when another event already paused it", async () => {
    verdict = "day";
    pause.mockResolvedValue(false);

    await receive();
    await Promise.all(deferred);

    expect(sync).not.toHaveBeenCalled();
  });

  it("uses the deployment's limits when it sets them", async () => {
    await receive({}, undefined, {
      ...ENV,
      ROUTINE_EVENT_RUNS_PER_HOUR: "5",
      ROUTINE_EVENT_RUNS_PER_DAY: "20",
    });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_per_hour: 5, p_per_day: 20 });
  });
});

describe("eventRunLimits", () => {
  it("ignores a value that is not a positive whole number", () => {
    expect(
      eventRunLimits({
        ...ENV,
        ROUTINE_EVENT_RUNS_PER_HOUR: "0",
        ROUTINE_EVENT_RUNS_PER_DAY: "lots",
      }),
    ).toEqual({ perHour: 60, perDay: 500 });
  });
});
