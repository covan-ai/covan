// worker/src/lib/routines/executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runRoutine,
  MAX_FAILURES,
  MAX_TRANSIENT_FAILURES,
  QUOTA_SKIP_REASON,
  type RoutineRow,
} from "./executor";
import { encryptSecret } from "./crypto";

// Task 11 wires a real DNS lookup into the Node fetch path so a hostname that
// merely resolves to a private address is still caught. That lookup is a
// dynamic `import("node:dns/promises")`, which vi.mock intercepts the same as
// a static one. Stub it so these tests keep exercising the fixture hostname
// "e.com" without depending on a real network round trip — the same reason
// fetchImpl itself is mocked rather than left to hit the network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

// Same fixture key used in delivery.test.ts. The stubbed `delivery_channels`
// row below must round-trip through the real decryptSecret (this module does
// not mock crypto), so the ciphertext has to be real AES-GCM output for this
// key rather than an arbitrary placeholder string.
const SECRET_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const ATOM = (ids: string[]) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  ${ids
    .map(
      (id, i) =>
        `<entry><id>${id}</id><title>T${id}</title><link href="https://e.com/${id}"/>
         <updated>2026-08-14T1${i}:00:00Z</updated><summary>s${id}</summary></entry>`,
    )
    .join("")}</feed>`;

// Node's Response constructor enforces the null-body-status list (304 among
// them) and throws if given a body at all, even "". Status 304 never carries
// a body in practice, so pass null for it and leave every other case as-is —
// same workaround source.test.ts already uses.
const res = (body: string, init: ResponseInit = {}) =>
  new Response(init.status === 304 ? null : body, init);

const routine = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  id: "r1",
  agent_id: "a1",
  user_id: "u1",
  workspace_id: "w1",
  name: "r/saas",
  source_kind: "rss",
  source_config: { url: "https://e.com/feed" },
  instruction: "Summarise",
  delivery_channel_id: "c1",
  schedule_cron: "*/15 * * * *",
  timezone: "UTC",
  next_run_at: "2026-08-14T10:00:00.000Z",
  cursor: null,
  consecutive_failures: 0,
  ...over,
});

/**
 * A Supabase-shaped stub. `updates` records every table the executor wrote to,
 * which is what the assertions below actually care about.
 *
 * `eq` returns itself so a chain of any length resolves — the executor scopes
 * every service-role read by more than an id (workspace_id on agents, user_id
 * on delivery_channels, both on workspace_members).
 */
function makeDb(
  over: { rows?: Record<string, any>; claimWins?: (keys: string[]) => string[] } = {},
) {
  const updates: Array<{ table: string; values: any }> = [];
  const inserts: Array<{ table: string; values: any }> = [];
  const claimed: string[] = [];

  const rowFor = async (table: string) => {
    if (over.rows && table in over.rows) return over.rows[table];
    if (table === "workspace_members") return { user_id: "u1" };
    if (table === "agents") return { persona: "You are a growth specialist", model: "gpt-4o" };
    if (table === "delivery_channels")
      return {
        kind: "slack_webhook",
        secret_ciphertext: await encryptSecret(
          "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE",
          SECRET_KEY,
        ),
      };
    return null;
  };

  const db = {
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: await rowFor(table), error: null }),
          single: async () => ({ data: await rowFor(table), error: null }),
        };
        return chain;
      },
      update: (values: any) => ({
        eq: async () => {
          updates.push({ table, values });
          return { error: null };
        },
      }),
      insert: (values: any) => {
        inserts.push({ table, values });
        return { error: null, select: async () => ({ data: [], error: null }) };
      },
      // Task 7's claimItemKeys reserves item keys via upsert (`onConflict` /
      // `ignoreDuplicates` are upsert-only options), not insert.
      upsert: (values: any) => {
        inserts.push({ table, values });
        if (table === "routine_deliveries") {
          const keys = (values as any[]).map((v) => v.item_key);
          // `ignoreDuplicates` returns only the rows this call actually
          // inserted, so a key another run already claimed comes back missing.
          const won = over.claimWins ? over.claimWins(keys) : keys;
          claimed.push(...won);
          return {
            select: async () => ({ data: won.map((item_key) => ({ item_key })), error: null }),
          };
        }
        return { select: async () => ({ data: [], error: null }) };
      },
      delete: () => ({
        eq: () => ({
          in: async (
            _c: string,
            _keys: string[],
          ): Promise<{ error: { message: string } | null }> => ({ error: null }),
        }),
      }),
    }),
  };
  // `any`: several tests below swap in a narrower `from` for one table, and the
  // inferred shape of this literal is not the contract they are testing.
  return { db: db as any, updates, inserts, claimed };
}

let fetchImpl: any;
let summarise: any;
let deliverCalls: any[];
/** Tokens charged through `entitlements.record`, per run. */
let recorded: Array<{ userId: string; tokens: number }>;

function makeDeps(db: any) {
  deliverCalls = [];
  recorded = [];
  return {
    db,
    summarise,
    // Unmetered by default, like a self-hosted install. The quota tests
    // override `check` on the returned object.
    entitlements: {
      check: vi.fn(async () => ({ allowed: true })),
      record: vi.fn(async (userId: string, tokens: number) => {
        recorded.push({ userId, tokens });
      }),
      snapshot: vi.fn(async () => ({ used: 0, limit: null, resetsAt: null })),
    },
    fetchDeps: { fetchImpl, ownHosts: ["api.example.com"] },
    deliveryDeps: {
      fetchImpl: vi.fn(async (url: string, init: any) => {
        deliverCalls.push({ url, init });
        return new Response("{}", { status: 200 });
      }) as any,
      secretKey: SECRET_KEY,
      resendApiKey: "re",
      resendFrom: "R <r@e.com>",
    },
    now: () => new Date("2026-08-14T10:07:00Z"),
  };
}

beforeEach(() => {
  summarise = vi.fn(async () => ({ text: "summary", tokens: 120 }));
});

describe("runRoutine", () => {
  it("delivers nothing on the first run but records the baseline cursor", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, updates } = makeDb();

    const out = await runRoutine(routine(), makeDeps(db) as any);

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.cursor.seenKeys).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("summarises and delivers the new items in one message", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
    const { db, claimed } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out).toEqual({ status: "ok", itemsNew: 2 });
    expect(summarise).toHaveBeenCalledTimes(1);
    expect(summarise.mock.calls[0][0].persona).toBe("You are a growth specialist");
    expect(summarise.mock.calls[0][0].items).toHaveLength(2);
    expect(deliverCalls).toHaveLength(1);
    expect(claimed).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("skips without an LLM call when the source is unchanged", async () => {
    fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: '"v1"', contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
  });

  it("runs a sourceless routine every time, including the first", async () => {
    fetchImpl = vi.fn();
    const { db } = makeDb();

    const out = await runRoutine(
      routine({ source_kind: "none", source_config: {} }),
      makeDeps(db) as any,
    );

    expect(out.status).toBe("ok");
    expect(summarise).toHaveBeenCalledTimes(1);
    expect(deliverCalls).toHaveLength(1);
  });

  it("charges the routine's owner for what the run cost", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const deps = makeDeps(db) as any;
    await runRoutine(r, deps);

    // The owner, not whoever triggered it — a scheduled run has no caller.
    expect(recorded).toEqual([{ userId: "u1", tokens: 120 }]);
  });

  it("skips without spending or claiming anything when the owner is out of quota", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, claimed, inserts } = makeDb();
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({
      allowed: false,
      used: 1000,
      limit: 1000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    }));

    const out = await runRoutine(
      routine({
        cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
      }),
      deps,
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
    // The one delivery is the notice explaining the skip, never a summary —
    // there is nothing to summarise, because the model was never called.
    expect(deliverCalls).toHaveLength(1);
    expect(JSON.stringify(deliverCalls[0].init.body)).toMatch(/allowance is used up/);
    // The important half: nothing was reserved. A delivery key claimed by a run
    // that then skips can never be claimed again, so those items would be lost
    // for good rather than reported once the allowance resets.
    expect(claimed).toEqual([]);
    const run = inserts.find((i: any) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("skipped");
    expect(run.values.error).toMatch(/quota/i);
  });

  it("tells the owner the first time a run is skipped for quota", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    // No prior run: rowFor("routine_runs") falls through to null.
    const { db } = makeDb();
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({
      allowed: false,
      used: 60000,
      limit: 60000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    }));

    await runRoutine(routine(), deps);

    expect(deliverCalls).toHaveLength(1);
    const sent = JSON.parse(deliverCalls[0].init.body);
    const text = JSON.stringify(sent);
    expect(text).toMatch(/allowance is used up/);
    // Says when it comes back, and that waiting costs them nothing.
    expect(text).toMatch(/1 September/);
    expect(text).toMatch(/Nothing has been lost/);
  });

  it("respects an owner who has turned the quota notice off", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb({
      rows: {
        notification_preferences: { routine_paused: true, quota_exhausted: false },
      },
    });
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({
      allowed: false,
      used: 60000,
      limit: 60000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    }));

    const out = await runRoutine(routine(), deps);

    // The run is still skipped and still recorded — the preference silences the
    // message, it does not change what the engine does.
    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(deliverCalls).toHaveLength(0);
  });

  // Ticks are minutes apart. Told once per tick, a routine waiting on a
  // monthly allowance would mail its owner thousands of times.
  it("stays quiet when the previous run was already a quota skip", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb({
      rows: {
        routine_runs: {
          status: "skipped",
          error: QUOTA_SKIP_REASON,
        },
      },
    });
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({
      allowed: false,
      used: 60000,
      limit: 60000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    }));

    await runRoutine(routine(), deps);

    expect(deliverCalls).toHaveLength(0);
  });

  // Without this the run history can say "Sent · 2 new items" but not what was
  // in them, so a mail that never arrived leaves no record anywhere.
  it("records the summary it sent alongside the run", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
    const { db, inserts } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.summary).toBe("summary");
  });

  it("records no summary for a run that sent nothing", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb();

    await runRoutine(routine(), makeDeps(db) as any);

    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("skipped");
    expect(run.values.summary).toBeNull();
  });

  it("advances next_run_at from the cron expression", async () => {
    fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const { db, updates } = makeDb();

    await runRoutine(routine(), makeDeps(db) as any);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(new Date(saved.values.next_run_at).toISOString()).toBe("2026-08-14T10:15:00.000Z");
    expect(saved.values.claimed_at).toBeNull();
    expect(saved.values.consecutive_failures).toBe(0);
  });

  it("records a failed run and backs off instead of throwing", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { db, updates, inserts } = makeDb();

    const out = await runRoutine(routine({ consecutive_failures: 1 }), makeDeps(db) as any);

    expect(out.status).toBe("failed");
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("failed");
    expect(run.values.error).toMatch(/upstream 500/);
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.consecutive_failures).toBe(2);
    // Backoff doubles per failure, but it multiplies the gap to the *next
    // aligned slot* (10:15, eight minutes after the 10:07 frozen clock), not
    // the 15-minute cron period itself. 2 failures doubles that 8-minute gap
    // to 16 minutes: 10:07 + 16m = 10:23.
    expect(new Date(saved.values.next_run_at).toISOString()).toBe("2026-08-14T10:23:00.000Z");
  });

  it("caps backoff at six hours past the natural next run for long periods", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { db, updates } = makeDb();

    await runRoutine(
      routine({
        schedule_cron: "0 9 * * *",
        timezone: "UTC",
        consecutive_failures: 2,
      }),
      makeDeps(db) as any,
    );

    const saved = updates.find((u) => u.table === "routines")!;
    // Natural next run is 2026-08-15T09:00:00Z, a gap of 22h53m from the frozen
    // 10:07 clock. Uncapped x4 geometric backoff would land four days out;
    // the six-hour cap instead gives 22h53m + 6h = 2026-08-15T15:00:00Z.
    expect(new Date(saved.values.next_run_at).toISOString()).toBe("2026-08-15T15:00:00.000Z");
  });

  it("pauses with a reason after the failure limit", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const { db, updates } = makeDb();

    await runRoutine(routine({ consecutive_failures: MAX_FAILURES - 1 }), makeDeps(db) as any);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBe("paused");
    expect(saved.values.paused_reason).toMatch(/upstream 404/);
  });

  // Reddit rate-limits datacenter IPs hard enough to fail a healthy routine
  // several ticks running. Weighing that the same as a 404 would take a working
  // routine offline until someone noticed and resumed it by hand.
  it.each([429, 500, 503])("does not pause at the normal limit for upstream %i", async (status) => {
    fetchImpl = vi.fn(async () => new Response("nope", { status }));
    const { db, updates } = makeDb();

    await runRoutine(routine({ consecutive_failures: MAX_FAILURES - 1 }), makeDeps(db) as any);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBeUndefined();
    // Still counted, still backed off — the failure is recorded, just not fatal.
    expect(saved.values.consecutive_failures).toBe(MAX_FAILURES);
  });

  it("pauses a source that has been failing transiently for far longer", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const { db, updates } = makeDb();

    await runRoutine(
      routine({ consecutive_failures: MAX_TRANSIENT_FAILURES - 1 }),
      makeDeps(db) as any,
    );

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBe("paused");
  });

  // A routine that dies quietly while the UI still says "active" is the failure
  // that destroys trust in this feature. The mail simply stops.
  it("tells the owner when it pauses a routine", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const { db } = makeDb();

    await runRoutine(routine({ consecutive_failures: MAX_FAILURES - 1 }), makeDeps(db) as any);

    expect(deliverCalls).toHaveLength(1);
    expect(JSON.stringify(deliverCalls[0].init.body)).toMatch(/paused/i);
  });

  it("still records the pause when the owner cannot be told", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const { db, updates } = makeDb();
    const deps = makeDeps(db) as any;
    deps.deliveryDeps.fetchImpl = vi.fn(async () => {
      throw new Error("slack is down");
    });

    await runRoutine(routine({ consecutive_failures: MAX_FAILURES - 1 }), deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBe("paused");
  });

  it("releases claimed keys when delivery fails, so the next run retries them", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const deps = makeDeps(db) as any;
    deps.deliveryDeps.fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const released: any[] = [];
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routine_deliveries") {
        return {
          ...table,
          delete: () => ({
            eq: () => ({
              in: async (_c: string, keys: string[]) => {
                released.push(...keys);
                return { error: null };
              },
            }),
          }),
        };
      }
      return table;
    };
    const r = routine({
      cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, deps);

    expect(out.status).toBe("failed");
    expect(released).toContain("a");
  });

  // The regression this ordering exists to prevent: the message is already in
  // the user's Slack, so handing the claims back would let the next tick — the
  // routine is re-claimable, since next_run_at and the cursor were never
  // advanced — win them again and send the identical summary a second time.
  it("keeps the claims when the bookkeeping fails after a successful delivery", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const released: string[] = [];
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routine_deliveries") {
        return {
          ...table,
          delete: () => ({
            eq: () => ({
              in: async (_c: string, keys: string[]) => {
                released.push(...keys);
                return { error: null };
              },
            }),
          }),
        };
      }
      if (t === "routines") {
        // Delivery succeeded; only the PATCH that follows it fails.
        return {
          ...table,
          update: () => ({ eq: async () => ({ error: { message: "patch boom" } }) }),
        };
      }
      return table;
    };
    const r = routine({
      cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(deliverCalls).toHaveLength(1);
    expect(out).toEqual({ status: "failed", itemsNew: 0 });
    expect(released).toEqual([]);
  });

  it("still resolves as failed, and attempts a bare claim reset, when finish() itself fails on the catch path", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { db, updates } = makeDb();
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routines") {
        return {
          ...table,
          update: (values: any) => ({
            eq: async () => {
              // The big patch from finish() carries last_run_at; the fallback
              // bare reset does not. Only the former should fail here.
              if ("last_run_at" in values) throw new Error("routines update boom");
              updates.push({ table: t, values });
              return { error: null };
            },
          }),
        };
      }
      return table;
    };

    const out = await runRoutine(routine({ consecutive_failures: 1 }), makeDeps(db) as any);

    expect(out).toEqual({ status: "failed", itemsNew: 0 });
    const bareReset = updates.find(
      (u) => u.table === "routines" && Object.keys(u.values).length === 1,
    );
    expect(bareReset?.values).toEqual({ claimed_at: null });
  });

  it("records both the delivery failure and an unreleased-claim warning when releaseItemKeys itself fails", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db, inserts } = makeDb();
    const deps = makeDeps(db) as any;
    deps.deliveryDeps.fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routine_deliveries") {
        return {
          ...table,
          delete: () => ({
            eq: () => ({
              in: async () => ({ error: { message: "delete boom" } }),
            }),
          }),
        };
      }
      return table;
    };
    const r = routine({
      cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, deps);

    expect(out.status).toBe("failed");
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.error).toMatch(/delivery failed/);
    expect(run.values.error).toMatch(/could not be released/);
  });

  it("checks the delivery channel before summarising, so a missing channel skips the LLM call", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb({ rows: { delivery_channels: null } });
    const r = routine({
      cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out.status).toBe("failed");
    expect(summarise).not.toHaveBeenCalled();
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("failed");
    expect(run.values.error).toMatch(/delivery channel missing/);
  });

  // ---- first run, web ------------------------------------------------------

  it("baselines a web routine's hash on the first run and delivers nothing", async () => {
    fetchImpl = vi.fn(async () => new Response("<html>the whole page</html>", { status: 200 }));
    const { db, updates } = makeDb();

    const out = await runRoutine(
      routine({ source_kind: "web", source_config: { url: "https://e.com/page" }, cursor: null }),
      makeDeps(db) as any,
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.cursor.contentHash).toEqual(expect.any(String));
  });

  it("delivers a web routine's change once it has a baseline to compare against", async () => {
    fetchImpl = vi.fn(async () => new Response("<html>changed</html>", { status: 200 }));
    const { db } = makeDb();

    const out = await runRoutine(
      routine({
        source_kind: "web",
        source_config: { url: "https://e.com/page" },
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: "old" },
      }),
      makeDeps(db) as any,
    );

    expect(out.status).toBe("ok");
    expect(deliverCalls).toHaveLength(1);
  });

  // ---- idempotency for the non-rss kinds -----------------------------------

  it("claims a web routine's content hash for its slot, so a retry of the same slot sends nothing", async () => {
    fetchImpl = vi.fn(async () => new Response("<html>changed</html>", { status: 200 }));
    // The key was already inserted by the run that overran its claim. That run
    // never advanced next_run_at, so the retry lands in the same slot.
    const { db, inserts } = makeDb({ claimWins: () => [] });

    const out = await runRoutine(
      routine({
        source_kind: "web",
        source_config: { url: "https://e.com/page" },
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: "old" },
      }),
      makeDeps(db) as any,
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
    const claim = inserts.find((i) => i.table === "routine_deliveries")!;
    expect(claim.values[0].item_key).toMatch(/^hash:[0-9a-f]{64}@2026-08-14T10:00:00\.000Z$/);
  });

  // The claim key is hash-and-slot, not hash alone: a page that oscillates
  // A→B→A→B must keep reporting, not fall permanently silent once each state
  // has been seen once.
  it("delivers content it has seen before when it recurs in a later slot", async () => {
    const page = "<html>degraded</html>";
    const keys: string[] = [];
    fetchImpl = vi.fn(async () => new Response(page, { status: 200 }));
    const { db } = makeDb({
      claimWins: (k) => {
        // Model the unique constraint: a key already inserted is not won again.
        const won = k.filter((key) => !keys.includes(key));
        keys.push(...won);
        return won;
      },
    });
    const web = (nextRun: string, seenHash: string) =>
      routine({
        source_kind: "web",
        source_config: { url: "https://e.com/page" },
        next_run_at: nextRun,
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: seenHash },
      });

    const deps = makeDeps(db) as any;

    const first = await runRoutine(web("2026-08-14T10:00:00.000Z", "operational"), deps);
    // The page flipped back to "degraded" a slot later — same bytes as before.
    const later = await runRoutine(web("2026-08-14T10:30:00.000Z", "operational"), deps);

    expect(first.status).toBe("ok");
    expect(later.status).toBe("ok");
    expect(deliverCalls).toHaveLength(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("claims a sourceless routine's scheduled slot, so a re-run of the same slot sends nothing", async () => {
    fetchImpl = vi.fn();
    const { db, inserts } = makeDb({ claimWins: () => [] });

    const out = await runRoutine(
      routine({ source_kind: "none", source_config: {}, next_run_at: "2026-08-14T10:00:00.000Z" }),
      makeDeps(db) as any,
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(summarise).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
    const claim = inserts.find((i) => i.table === "routine_deliveries")!;
    expect(claim.values[0].item_key).toBe("slot:2026-08-14T10:00:00.000Z");
  });

  // ---- membership ----------------------------------------------------------

  it("pauses instead of running when the owner is no longer a workspace member", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, updates, inserts } = makeDb({ rows: { workspace_members: null } });

    const out = await runRoutine(
      routine({
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
      }),
      makeDeps(db) as any,
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBe("paused");
    expect(saved.values.paused_reason).toMatch(/no longer a member/);
    // Recorded, not silent: the owner has to be able to see why it stopped.
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.error).toMatch(/no longer a member/);
    // Nothing is deleted — the routine survives being re-added to the workspace.
    expect(saved.values.cursor).toBeUndefined();
  });

  // ---- database errors are results, not exceptions --------------------------

  it("treats a failed routine_runs insert as an error rather than losing the run", async () => {
    fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const { db } = makeDb();
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routine_runs") {
        return { ...table, insert: () => ({ error: { message: "runs insert boom" } }) };
      }
      return table;
    };

    const out = await runRoutine(routine(), makeDeps(db) as any);

    // The skipped path's finish() threw, so the catch path took over: the run
    // resolves as failed rather than reporting a success that never landed.
    expect(out.status).toBe("failed");
  });

  it("treats a failed routines update as an error, and falls back to a bare claim reset", async () => {
    fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { db, updates } = makeDb();
    const originalFrom = db.from;
    db.from = (t: string) => {
      const table = originalFrom(t);
      if (t === "routines") {
        return {
          ...table,
          update: (values: any) => ({
            eq: async () => {
              // postgrest-js resolves { error }, it does not throw. The big
              // patch from finish() carries last_run_at; the fallback does not.
              if ("last_run_at" in values) return { error: { message: "update boom" } };
              updates.push({ table: t, values });
              return { error: null };
            },
          }),
        };
      }
      return table;
    };

    const out = await runRoutine(routine({ consecutive_failures: 1 }), makeDeps(db) as any);

    expect(out).toEqual({ status: "failed", itemsNew: 0 });
    const bareReset = updates.find(
      (u) => u.table === "routines" && Object.keys(u.values).length === 1,
    );
    expect(bareReset?.values).toEqual({ claimed_at: null });
  });
});
