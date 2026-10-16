import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import { decryptSecret, encryptSecret } from "../../secret-box";
import { EventSourceError, type EventAdapter, type EventRegistry } from "./adapter";
import { catalogueOf, type EventTypeDef } from "./catalog";

vi.mock("../../supabase", () => ({
  serviceClient: () => {
    throw new Error("a test must hand in its own db");
  },
}));

const {
  lapseSubscriptions,
  releaseSubscription,
  replaceSubscription,
  retryDelayMs,
  sweepEventSubscriptions,
  syncSubscription,
} = await import("./lifecycle");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY } as RoutineEnv;
const NOW = new Date("2026-10-16T12:00:00Z");

const MAIL: EventTypeDef = {
  id: "mail.new",
  provider: "composio",
  app: "Mail",
  label: "New mail",
  description: "A mail arrives.",
  requires: { kind: "none" },
  config: z.object({ query: z.string().optional() }),
  fields: [],
  sample: { eventId: "sample", text: "From: someone" },
};

type MockAdapter = EventAdapter & {
  subscribe: Mock;
  unsubscribe: Mock;
  setEnabled: Mock;
  normalize: Mock;
  renew?: Mock;
};

function adapter(over: Partial<EventAdapter> = {}): MockAdapter {
  return {
    provider: "composio",
    isConfigured: () => true,
    subscribe: vi.fn(async () => ({ externalId: "ti_1" })),
    unsubscribe: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    normalize: vi.fn(async () => null),
    ...over,
  } as MockAdapter;
}

function registryWith(a: EventAdapter | undefined): EventRegistry {
  return { ...catalogueOf([MAIL]), adapterFor: (p) => (p === "composio" ? a : undefined) };
}

const routine = (over: Row = {}): Row => ({
  id: "r1",
  user_id: "u1",
  workspace_id: "w1",
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
  external_id: null,
  secret_ciphertext: null,
  state: {},
  status: "pending",
  status_detail: null,
  expires_at: null,
  attempts: 0,
  next_attempt_at: null,
  ...over,
});

function seed(sub: Row | null, r: Row | null = routine()) {
  return memoryDb({
    routines: r ? [r] : [],
    routine_event_subscriptions: sub ? [sub] : [],
  });
}

const deps = (db: ReturnType<typeof seed>, a: EventAdapter | undefined) => ({
  db: db.db as unknown as SupabaseClient,
  registry: registryWith(a),
  now: () => NOW,
});

let mail: ReturnType<typeof adapter>;
beforeEach(() => {
  mail = adapter();
});

describe("syncSubscription", () => {
  it("subscribes a pending row and writes down what the provider said", async () => {
    const db = seed(subscription());

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    expect(out).toEqual({ status: "active", detail: null });
    expect(mail.subscribe).toHaveBeenCalledOnce();
    expect(db.tables.routine_event_subscriptions[0]).toMatchObject({
      status: "active",
      external_id: "ti_1",
      attempts: 0,
      next_attempt_at: null,
    });
  });

  // An adapter never touches the database, so a secret it hands back is
  // sealed here, and only here, before it is written.
  it("seals a secret the provider hands back", async () => {
    mail.subscribe = vi.fn(async () => ({ externalId: "bot_1", secret: "123:telegram-token" }));
    const db = seed(subscription());

    await syncSubscription(ENV, "r1", deps(db, mail));

    const stored = db.tables.routine_event_subscriptions[0].secret_ciphertext as string;
    expect(stored).not.toContain("telegram-token");
    expect(await decryptSecret(stored, KEY)).toBe("123:telegram-token");
  });

  it("opens the stored secret for the adapter", async () => {
    const db = seed(
      subscription({
        status: "active",
        external_id: "bot_1",
        secret_ciphertext: await encryptSecret("the-token", KEY),
      }),
      routine({ status: "paused" }),
    );

    await syncSubscription(ENV, "r1", deps(db, mail));

    expect(mail.setEnabled.mock.calls[0][0].secret).toBe("the-token");
  });

  it("records a refusal the owner can act on, and backs off", async () => {
    mail.subscribe = vi.fn(async () => {
      throw new EventSourceError("Gmail asked for a query it can read.");
    });
    const db = seed(subscription({ attempts: 2 }));

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    expect(out).toEqual({ status: "failed", detail: "Gmail asked for a query it can read." });
    const row = db.tables.routine_event_subscriptions[0];
    expect(row.attempts).toBe(3);
    expect(row.next_attempt_at).toBe(new Date(NOW.getTime() + retryDelayMs(3)).toISOString());
  });

  // No number of retries reconnects somebody's account for them, so an
  // expired row is left for a person rather than claimed again.
  it("marks a lapsed connection expired and stops retrying it", async () => {
    mail.subscribe = vi.fn(async () => {
      throw new EventSourceError("Mail is no longer connected.", { expired: true });
    });
    const db = seed(subscription());

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    expect(out.status).toBe("expired");
    expect(db.tables.routine_event_subscriptions[0].next_attempt_at).toBeNull();
  });

  it("says something generic, not the provider's raw error, when it throws otherwise", async () => {
    mail.subscribe = vi.fn(async () => {
      throw new Error("503 from backend.example.com with a stack trace");
    });
    const db = seed(subscription());
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    quiet.mockRestore();
    expect(out.status).toBe("failed");
    expect(out.detail).toBe("Could not reach Mail to set this up. Covan will keep trying.");
  });

  it("refuses with a sentence when this deployment has no adapter for it", async () => {
    const db = seed(subscription());

    const out = await syncSubscription(ENV, "r1", deps(db, undefined));

    expect(out).toEqual({
      status: "failed",
      detail: "This deployment can no longer listen for Mail events.",
    });
  });

  // A paused routine should not be sent events, and on some providers each
  // one costs. Paused — not forgotten — so Resume needs no fresh subscribe.
  it("pauses the arrangement when the routine is paused", async () => {
    const db = seed(
      subscription({ status: "active", external_id: "ti_1" }),
      routine({ status: "paused" }),
    );

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    expect(out.status).toBe("disabled");
    expect(mail.setEnabled).toHaveBeenCalledWith(expect.anything(), false);
    expect(mail.subscribe).not.toHaveBeenCalled();
  });

  it("does the same for a routine binned with its agent", async () => {
    const db = seed(
      subscription({ status: "active", external_id: "ti_1" }),
      routine({ deleted_at: "2026-10-15T00:00:00Z" }),
    );

    expect((await syncSubscription(ENV, "r1", deps(db, mail))).status).toBe("disabled");
    expect(mail.setEnabled).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("has nothing to tell the provider about a row it never reached", async () => {
    const db = seed(subscription(), routine({ status: "paused" }));

    expect((await syncSubscription(ENV, "r1", deps(db, mail))).status).toBe("disabled");
    expect(mail.setEnabled).not.toHaveBeenCalled();
  });

  it("resumes a disabled arrangement rather than making a new one", async () => {
    const db = seed(subscription({ status: "disabled", external_id: "ti_1" }));

    expect((await syncSubscription(ENV, "r1", deps(db, mail))).status).toBe("active");
    expect(mail.setEnabled).toHaveBeenCalledWith(expect.anything(), true);
    expect(mail.subscribe).not.toHaveBeenCalled();
  });

  it("renews an arrangement that lapses within the day", async () => {
    mail.renew = vi.fn(async () => ({ expiresAt: new Date("2026-10-23T12:00:00Z") }));
    const db = seed(
      subscription({ status: "active", external_id: "ch_1", expires_at: "2026-10-17T06:00:00Z" }),
    );

    await syncSubscription(ENV, "r1", deps(db, mail));

    expect(mail.renew).toHaveBeenCalledOnce();
    expect(db.tables.routine_event_subscriptions[0].expires_at).toBe("2026-10-23T12:00:00.000Z");
  });

  it("leaves one that lapses next week alone", async () => {
    mail.renew = vi.fn();
    const db = seed(
      subscription({ status: "active", external_id: "ch_1", expires_at: "2026-10-23T06:00:00Z" }),
    );

    await syncSubscription(ENV, "r1", deps(db, mail));

    expect(mail.renew).not.toHaveBeenCalled();
  });

  it("releases the row once the routine stops waiting for an event", async () => {
    const db = seed(
      subscription({ status: "active", external_id: "ti_1" }),
      routine({ trigger_kind: "schedule" }),
    );

    const out = await syncSubscription(ENV, "r1", deps(db, mail));

    expect(out.status).toBeNull();
    expect(mail.unsubscribe).toHaveBeenCalledOnce();
    expect(db.tables.routine_event_subscriptions).toEqual([]);
  });

  it("answers null for a routine with no subscription", async () => {
    const db = seed(null);
    expect(await syncSubscription(ENV, "r1", deps(db, mail))).toEqual({
      status: null,
      detail: null,
    });
  });
});

describe("releaseSubscription", () => {
  it("unsubscribes at the provider and then forgets the row", async () => {
    const db = seed(subscription({ status: "active", external_id: "ti_1" }));

    await releaseSubscription(ENV, "r1", deps(db, mail));

    expect(mail.unsubscribe).toHaveBeenCalledOnce();
    expect(db.tables.routine_event_subscriptions).toEqual([]);
  });

  // A provider that cannot be reached must not keep a deleted routine alive.
  it("forgets the row even when the provider cannot be reached", async () => {
    mail.unsubscribe = vi.fn(async () => {
      throw new Error("timeout");
    });
    const db = seed(subscription({ status: "active", external_id: "ti_1" }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await releaseSubscription(ENV, "r1", deps(db, mail));

    quiet.mockRestore();
    expect(db.tables.routine_event_subscriptions).toEqual([]);
  });

  it("does not call a provider that was never reached", async () => {
    const db = seed(subscription());
    await releaseSubscription(ENV, "r1", deps(db, mail));
    expect(mail.unsubscribe).not.toHaveBeenCalled();
  });
});

describe("replaceSubscription", () => {
  // Nothing of the old arrangement may carry over: its id would be
  // "unsubscribed" later at the wrong provider.
  it("ends the old arrangement before making the new one", async () => {
    const db = seed(
      subscription({ status: "active", external_id: "ti_old", config: { query: "a" } }),
    );

    const out = await replaceSubscription(
      ENV,
      "r1",
      { def: MAIL, config: { query: "from:boss" } },
      deps(db, mail),
    );

    expect(mail.unsubscribe.mock.calls[0][0].subscription.external_id).toBe("ti_old");
    expect(out.status).toBe("active");
    expect(db.tables.routine_event_subscriptions).toHaveLength(1);
    expect(db.tables.routine_event_subscriptions[0]).toMatchObject({
      event_type: "mail.new",
      config: { query: "from:boss" },
      external_id: "ti_1",
    });
  });

  // A Telegram bot token: never in `config`, sealed on the way in, and what
  // the adapter is handed as `ctx.secret` on its first subscribe.
  it("seals a credential that came with the choice and hands it to the adapter", async () => {
    const db = seed(null);

    await replaceSubscription(
      ENV,
      "r1",
      { def: MAIL, config: {}, secret: "123:bot-token" },
      deps(db, mail),
    );

    const row = db.tables.routine_event_subscriptions[0];
    expect(row.config).toEqual({});
    expect(typeof row.secret_ciphertext).toBe("string");
    expect(row.secret_ciphertext).not.toContain("bot-token");
    expect(await decryptSecret(row.secret_ciphertext as string, ENV.ROUTINE_SECRET_KEY)).toBe(
      "123:bot-token",
    );
    expect(mail.subscribe.mock.calls[0][0].secret).toBe("123:bot-token");
  });
});

describe("sweepEventSubscriptions", () => {
  it("syncs what the claim hands it", async () => {
    const db = seed(subscription());
    const rpc = vi.fn(async () => ({ data: [{ routine_id: "r1" }], error: null }));
    (db.db as unknown as { rpc: unknown }).rpc = rpc;

    const out = await sweepEventSubscriptions(ENV, deps(db, mail));

    expect(rpc).toHaveBeenCalledWith("claim_event_subscriptions", { p_limit: 3 });
    expect(out).toEqual({ claimed: 1 });
    expect(db.tables.routine_event_subscriptions[0].status).toBe("active");
  });

  it("costs one claim when nothing is out of step", async () => {
    const db = seed(null);
    (db.db as unknown as { rpc: unknown }).rpc = vi.fn(async () => ({ data: [], error: null }));

    expect(await sweepEventSubscriptions(ENV, deps(db, mail))).toEqual({ claimed: 0 });
  });
});

describe("retryDelayMs", () => {
  it("starts at five minutes, doubles, and never waits more than a day", () => {
    expect(retryDelayMs(1)).toBe(5 * 60_000);
    expect(retryDelayMs(2)).toBe(10 * 60_000);
    expect(retryDelayMs(40)).toBe(24 * 60 * 60_000);
  });
});

describe("lapseSubscriptions", () => {
  const announce = vi.fn(async () => {});
  beforeEach(() => announce.mockClear());

  it("expires every row listening through a removed connection, ends it at the source and tells each owner once", async () => {
    const db = memoryDb({
      routines: [routine(), routine({ id: "r2" })],
      routine_event_subscriptions: [
        subscription({ status: "active", external_id: "ti_1", config: { connectionId: "tc1" } }),
        subscription({
          routine_id: "r2",
          status: "disabled",
          external_id: "ti_2",
          config: { connectionId: "tc1" },
        }),
        subscription({
          routine_id: "r3",
          status: "active",
          external_id: "ti_3",
          config: { connectionId: "tc-other" },
        }),
      ],
    });

    const lapsed = await lapseSubscriptions(
      ENV,
      { config: { connectionId: "tc1" } },
      "gmail was disconnected.",
      { ...deps(db, mail), announce },
    );

    expect(lapsed.sort()).toEqual(["r1", "r2"]);
    expect(mail.unsubscribe).toHaveBeenCalledTimes(2);
    const rows = db.tables.routine_event_subscriptions;
    expect(rows.find((r) => r.routine_id === "r1")).toMatchObject({
      status: "expired",
      status_detail: "gmail was disconnected.",
      external_id: null,
    });
    expect(rows.find((r) => r.routine_id === "r3")).toMatchObject({ status: "active" });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("finds rows by what the adapter recorded, and by the provider's own id", async () => {
    const db = memoryDb({
      routines: [routine()],
      routine_event_subscriptions: [
        subscription({
          status: "active",
          external_id: "ti_1",
          state: { connectedAccountId: "ca_1" },
        }),
      ],
    });
    expect(
      await lapseSubscriptions(ENV, { state: { connectedAccountId: "ca_9" } }, "x", deps(db, mail)),
    ).toEqual([]);
    expect(
      await lapseSubscriptions(
        ENV,
        { provider: "composio", externalId: "ti_1" },
        "x",
        deps(db, mail),
      ),
    ).toEqual(["r1"]);
  });

  it("does not tell anybody twice when the provider repeats itself", async () => {
    const db = memoryDb({
      routines: [routine()],
      routine_event_subscriptions: [
        subscription({
          status: "active",
          external_id: "ti_1",
          state: { connectedAccountId: "ca_1" },
        }),
      ],
    });
    const match = { state: { connectedAccountId: "ca_1" } };
    await lapseSubscriptions(ENV, match, "expired", { ...deps(db, mail), announce });
    await lapseSubscriptions(ENV, match, "expired", { ...deps(db, mail), announce });
    expect(announce).toHaveBeenCalledOnce();
  });

  it("keeps the provider's id when ending it failed, so a later release can try again", async () => {
    mail = adapter({ unsubscribe: vi.fn(async () => Promise.reject(new Error("down"))) });
    const db = memoryDb({
      routines: [routine()],
      routine_event_subscriptions: [
        subscription({ status: "active", external_id: "ti_1", config: { connectionId: "tc1" } }),
      ],
    });
    await lapseSubscriptions(ENV, { config: { connectionId: "tc1" } }, "gone", deps(db, mail));
    expect(db.tables.routine_event_subscriptions[0]).toMatchObject({
      status: "expired",
      external_id: "ti_1",
    });
  });
});
