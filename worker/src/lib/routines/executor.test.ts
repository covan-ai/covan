// worker/src/lib/routines/executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runRoutine,
  MAX_FAILURES,
  MAX_TRANSIENT_FAILURES,
  QUOTA_SKIP_REASON,
  NOTHING_RELEVANT_REASON,
  type RoutineRow,
} from "./executor";
import { encryptSecret } from "../secret-box";
import { serialiseWebhookSecret } from "./webhook";
import type { Spend } from "../entitlements";

// Task 11 wires a real DNS lookup into the Node fetch path so a hostname that
// merely resolves to a private address is still caught. That lookup is a
// dynamic `import("node:dns/promises")`, which vi.mock intercepts the same as
// a static one. Stub it so these tests keep exercising the fixture hostname
// "e.com" without depending on a real network round trip — the same reason
// fetchImpl itself is mocked rather than left to hit the network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

/**
 * A completion a producer reports, marked by its prompt count so each test can
 * tell which spend reached the ledger. The executor never prices anything; it
 * only passes these on.
 */
const S = (n: number): Spend => ({
  kind: "completion",
  model: "gpt-4o",
  promptTokens: n,
  completionTokens: 0,
  purpose: "routine",
});
const E = (tokens: number, purpose: "retrieval" | "index" = "retrieval"): Spend => ({
  kind: "embedding",
  model: "text-embedding-3-small",
  tokens,
  purpose,
});

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
  // Null and 0 — 0074's default for every row that existed before it, and the
  // value every test above this one implicitly wants: a routine that never
  // ends.
  ends_after_runs: null,
  runs_done: 0,
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
  over: {
    rows?: Record<string, any>;
    claimWins?: (keys: string[]) => string[];
    /** Rows a `connection` routine's document read resolves to. */
    documents?: any[];
  } = {},
) {
  const updates: Array<{ table: string; values: any }> = [];
  const inserts: Array<{ table: string; values: any }> = [];
  const claimed: string[] = [];
  /** Keys handed back through `releaseItemKeys`, in the order they were. */
  const released: string[] = [];

  const rowFor = async (table: string) => {
    if (over.rows && table in over.rows) return over.rows[table];
    // `role` as well as `user_id`, because the executor now reads both: a
    // viewer keeps delivering and stops filing. Defaulting to `member` is what
    // every test above this one means.
    if (table === "workspace_members") return { user_id: "u1", role: "member" };
    if (table === "agents") return { persona: "You are a growth specialist", model: "gpt-4o" };
    // A `connection` routine looks its connection up scoped to the routine's
    // own workspace before it reads a single document. See connection-source.ts.
    if (table === "connections") return { id: "cn1" };
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
          // The agent lookup asks `.is("deleted_at", null)`: the executor holds
          // a service-role client, so nothing else is filtering a soft-deleted
          // agent out of its way.
          is: () => chain,
          order: () => chain,
          // Two callers end a chain with `.limit()` and want different things
          // from it: `lastRunWasQuotaSkip` follows it with `.maybeSingle()`,
          // and the document read for a `connection` routine awaits it. A
          // promise carrying the extra method satisfies both, which is what
          // postgrest-js's builder does too.
          limit: () => {
            const pending: any = Promise.resolve({ data: over.documents ?? [], error: null });
            pending.maybeSingle = chain.maybeSingle;
            return pending;
          },
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
            keys: string[],
          ): Promise<{ error: { message: string } | null }> => {
            if (table === "routine_deliveries") released.push(...keys);
            return { error: null };
          },
        }),
      }),
    }),
  };
  // `any`: several tests below swap in a narrower `from` for one table, and the
  // inferred shape of this literal is not the contract they are testing.
  return { db: db as any, updates, inserts, claimed, released };
}

let fetchImpl: any;
let summarise: any;
let retrieve: any;
let deliverCalls: any[];
/** What reached `entitlements.record`, per run. */
let recorded: Array<{ workspaceId: string; spend: Spend[] }>;

function makeDeps(db: any) {
  deliverCalls = [];
  recorded = [];
  return {
    db,
    env: { OPENAI_API_KEY: "sk-test" },
    summarise,
    retrieve,
    // Unmetered by default, like a self-hosted install. The credit tests
    // override `check` on the returned object.
    entitlements: {
      check: vi.fn(async (_workspaceId: string) => ({ allowed: true })),
      record: vi.fn(async (workspaceId: string, spend: Spend[]) => {
        recorded.push({ workspaceId, spend });
      }),
      snapshot: vi.fn(async () => ({ metered: false })),
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
      ownHosts: ["api.example.com"],
    },
    now: () => new Date("2026-08-14T10:07:00Z"),
  };
}

beforeEach(() => {
  summarise = vi.fn(async () => ({
    text: "summary",
    tokens: 120,
    // Deliberately not 120. Every assertion on `recorded` below is then a
    // statement about which of the two the ledger is told — the spend, never
    // the raw count beside it.
    spend: [S(45)],
    declined: false,
  }));
  // Ungrounded by default, so the assertions below are about what the executor
  // does with a block rather than about whether one was produced. The tests
  // that care override this.
  retrieve = vi.fn(async () => ({ ragBlock: "", embeddingTokens: 0 }));
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
    // The schedule's own zone reaches the model, so "9am" in the cron and
    // "9am" in the answer are the same 9am. Asserted at the one place the
    // input is built, because a field nothing fills is how `message_steps
    // .tokens` spent a release NULL on every row.
    expect(summarise.mock.calls[0][0].timezone).toBe("UTC");
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

  it("charges the routine's workspace for what the run cost", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const deps = makeDeps(db) as any;
    await runRoutine(r, deps);

    // The routine's workspace, not whoever triggered it — a scheduled run has
    // no caller. The owner is who the charge is attributed to.
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(45)] }]);
    expect(deps.entitlements.record.mock.calls[0][2]).toMatchObject({ userId: "u1" });
  });

  it("skips without spending or claiming anything when the workspace is out of credits", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, claimed, inserts } = makeDb();
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({ allowed: false, balance: 0 }));

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
    expect(JSON.stringify(deliverCalls[0].init.body)).toMatch(/no credits left/);
    // The important half: nothing was reserved. A delivery key claimed by a run
    // that then skips can never be claimed again, so those items would be lost
    // for good rather than reported once credits are added.
    expect(claimed).toEqual([]);
    const run = inserts.find((i: any) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("skipped");
    expect(run.values.error).toBe(QUOTA_SKIP_REASON);
    expect(run.values.error).toMatch(/credits/i);
    // Asked of the routine's workspace, whoever owns the routine.
    expect(deps.entitlements.check).toHaveBeenCalledWith("w1");
  });

  it("tells the owner the first time a run is skipped for credits", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    // No prior run: rowFor("routine_runs") falls through to null.
    const { db } = makeDb();
    const deps = makeDeps(db) as any;
    deps.entitlements.check = vi.fn(async () => ({ allowed: false, balance: 0 }));

    await runRoutine(routine(), deps);

    expect(deliverCalls).toHaveLength(1);
    const sent = JSON.parse(deliverCalls[0].init.body);
    const text = JSON.stringify(sent);
    expect(text).toMatch(/no credits left/);
    // Says what brings it back, and that waiting costs them nothing.
    expect(text).toMatch(/admin adds credits/);
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
    deps.entitlements.check = vi.fn(async () => ({ allowed: false, balance: 0 }));

    const out = await runRoutine(routine(), deps);

    // The run is still skipped and still recorded — the preference silences the
    // message, it does not change what the engine does.
    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(deliverCalls).toHaveLength(0);
  });

  // Ticks are minutes apart. Told once per tick, a routine waiting on credits
  // would mail its owner thousands of times.
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
    deps.entitlements.check = vi.fn(async () => ({ allowed: false, balance: 0 }));

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

  /**
   * What model answered, and how it stopped — the two facts `messages` has
   * carried since 0064 and 0065 and `routine_runs` had not.
   *
   * `status` is a delivery verdict and stays one: `ok` means something was
   * sent. It cannot tell a report the model finished from a report cut off at
   * its token ceiling, and on the one surface with nobody watching it that is
   * the difference between a routine working and a routine quietly delivering
   * three quarters of the job. See 0070.
   */
  describe("what the model did, on a run nobody watched", () => {
    it("records which model answered and how it ended", async () => {
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      summarise = vi.fn(async () => ({
        text: "summary",
        tokens: 120,
        spend: [S(45)],
        declined: false,
        model: "gpt-4.1",
        modelOutcome: "answered" as const,
      }));
      const { db, inserts } = makeDb();
      const r = routine({
        cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
      });

      await runRoutine(r, makeDeps(db) as any);

      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.model).toBe("gpt-4.1");
      expect(run.values.outcome).toBe("answered");
    });

    it("says truncated on a run whose report was cut off", async () => {
      // `status` is still `ok` — something was delivered. The two columns
      // answer different questions, which is why widening `status` was not the
      // fix.
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      summarise = vi.fn(async () => ({
        text: "summary",
        tokens: 120,
        spend: [S(45)],
        declined: false,
        model: "gpt-4.1",
        modelOutcome: "truncated" as const,
      }));
      const { db, inserts } = makeDb();
      const r = routine({
        cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
      });

      await runRoutine(r, makeDeps(db) as any);

      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.status).toBe("ok");
      expect(run.values.outcome).toBe("truncated");
    });

    it("leaves both null for a run that never called a model", async () => {
      // Null rather than a guess. A feed that had not moved made no model call,
      // so there is no model and no outcome — and a zero-ish default here would
      // be a claim about a request nobody sent.
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
      const { db, inserts } = makeDb();

      await runRoutine(routine(), makeDeps(db) as any);

      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.status).toBe("skipped");
      expect(run.values.model).toBeNull();
      expect(run.values.outcome).toBeNull();
    });

    it("keeps them on a run that read the material and declined to send", async () => {
      // A declined run is `skipped` and still made a model call — two of them,
      // in fact. The columns describe the call, not the delivery.
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      summarise = vi.fn(async () => ({
        text: "",
        tokens: 120,
        spend: [S(45)],
        declined: true,
        model: "gpt-4.1",
        modelOutcome: "answered" as const,
      }));
      const { db, inserts } = makeDb();
      const r = routine({
        cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
      });

      await runRoutine(r, makeDeps(db) as any);

      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.status).toBe("skipped");
      expect(run.values.model).toBe("gpt-4.1");
      expect(run.values.outcome).toBe("answered");
    });
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
    // A 500 from the receiver is the remote's fault, so it reads as an upstream
    // failure and counts against the higher limit — but what the receiver
    // actually said is still in the string, and so is the claim warning.
    expect(run.values.error).toMatch(/upstream 500/);
    expect(run.values.error).toMatch(/no/);
    expect(run.values.error).toMatch(/could not be released/);
  });

  // The change this pairs with: a receiver having a bad ten minutes must not
  // pause a working routine at five, and a receiver that is simply pointed at
  // the wrong URL must not be retried twenty times before anybody is told.
  it("counts a 5xx from the delivery channel against the transient limit", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db, updates } = makeDb();
    const deps = makeDeps(db) as any;
    deps.deliveryDeps.fetchImpl = vi.fn(async () => new Response("gateway", { status: 503 }));

    await runRoutine(
      routine({
        consecutive_failures: MAX_FAILURES - 1,
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
      }),
      deps,
    );

    const patch = updates.find((u) => u.table === "routines" && "consecutive_failures" in u.values);
    expect(patch?.values.consecutive_failures).toBe(MAX_FAILURES);
    // Would have paused before this change. MAX_TRANSIENT_FAILURES is the bar.
    expect(patch?.values.status).toBeUndefined();
  });

  it("still pauses at five when the channel itself is wrong", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db, updates } = makeDb();
    const deps = makeDeps(db) as any;
    deps.deliveryDeps.fetchImpl = vi.fn(async () => new Response("no such hook", { status: 404 }));

    await runRoutine(
      routine({
        consecutive_failures: MAX_FAILURES - 1,
        cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
      }),
      deps,
    );

    const patch = updates.find((u) => u.table === "routines" && "consecutive_failures" in u.values);
    expect(patch?.values.status).toBe("paused");
    expect(patch?.values.paused_reason).toMatch(/404/);
  });

  // ---- a run something else started ------------------------------------

  describe("when a webhook poked it", () => {
    const poked = (over: Partial<RoutineRow> = {}) =>
      routine({ source_kind: "none", source_config: {}, ...over });
    const trigger = { eventId: "evt-1", payload: '{"deploy":"finished"}' };

    it("claims the sender's event id, not a clock slot", async () => {
      const { db, inserts } = makeDb();

      await runRoutine(poked(), makeDeps(db) as any, trigger);

      const claim = inserts.find((i) => i.table === "routine_deliveries")!;
      expect(claim.values).toMatchObject([{ item_key: "hook:evt-1" }]);
    });

    // Every webhook sender worth using delivers twice. The second one must cost
    // nothing and must still be visible — a silent 200 leaves somebody
    // wondering whether their routine ran.
    it("is a visible skipped run the second time, with no model call", async () => {
      const { db, inserts } = makeDb({ claimWins: () => [] });

      const out = await runRoutine(poked(), makeDeps(db) as any, trigger);

      expect(out).toEqual({ status: "skipped", itemsNew: 0 });
      expect(summarise).not.toHaveBeenCalled();
      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.status).toBe("skipped");
    });

    it("gives the model the payload, and says where it came from", async () => {
      const { db } = makeDb();

      await runRoutine(poked(), makeDeps(db) as any, trigger);

      expect(summarise.mock.calls[0][0]).toMatchObject({
        payloadText: '{"deploy":"finished"}',
        // A poked run has material its output can be irrelevant to, unlike a
        // scheduled prompt — so it is allowed to decide there is nothing worth
        // sending, which is most of what a webhook routine is asked to do.
        mayDecline: true,
      });
    });

    it("tells the receiver a poke started it", async () => {
      const { db } = makeDb({
        rows: {
          delivery_channels: {
            kind: "webhook",
            secret_ciphertext: await encryptSecret(
              serialiseWebhookSecret({
                url: "https://receiver.example.com/covan",
                signingSecret: "whsec_TEST",
              }),
              SECRET_KEY,
            ),
          },
        },
      });

      await runRoutine(poked(), makeDeps(db) as any, trigger);

      const body = JSON.parse(deliverCalls[0].init.body as string);
      expect(body.run.triggeredBy).toBe("webhook");
      expect(body.event).toBe("routine.delivered");
    });

    // 0013's claim — "a watched feed is never mirrored into our database" — has
    // to survive a payload arriving by POST rather than being fetched. Only the
    // summary the agent wrote is kept.
    it("writes the payload nowhere", async () => {
      const { db, inserts, updates } = makeDb();
      const secret = '{"customer":"acme","card":"4111111111111111"}';

      await runRoutine(poked(), makeDeps(db) as any, { eventId: "evt-2", payload: secret });

      const written = JSON.stringify([...inserts, ...updates]);
      expect(written).not.toContain("4111111111111111");
      expect(written).not.toContain("acme");
      // And the run row did keep what the agent wrote about it.
      expect(inserts.find((i) => i.table === "routine_runs")!.values.summary).toBe("summary");
    });

    it("is still a scheduled run when nothing poked it", async () => {
      const { db, inserts } = makeDb();

      await runRoutine(poked(), makeDeps(db) as any);

      const claim = inserts.find((i) => i.table === "routine_deliveries")!;
      expect((claim.values as { item_key: string }[])[0].item_key).toMatch(/^slot:/);
      expect(summarise.mock.calls[0][0].payloadText).toBeUndefined();
    });
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

  it("claims a distinct manual key for on-demand runs so it does not collide with scheduled slots", async () => {
    fetchImpl = vi.fn();
    const { db, inserts } = makeDb({ claimWins: () => [] });

    const out = await runRoutine(
      routine({
        id: "r1",
        source_kind: "none",
        source_config: {},
        next_run_at: "2026-08-14T10:00:00.000Z",
      }),
      { ...(makeDeps(db) as any), trigger: "manual" },
    );

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    const claim = inserts.find((i) => i.table === "routine_deliveries")!;
    expect(claim.values[0].item_key).toMatch(/^manual:r1@/);
    expect(claim.values[0].item_key).not.toContain("slot:");
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
        return {
          ...table,
          insert: () => ({
            select: async () => ({ data: null, error: { message: "runs insert boom" } }),
          }),
        };
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

  // ---- what the agent knows ------------------------------------------------
  //
  // A routine is meant to be the same colleague as the one in the chat window,
  // reporting rather than answering. It was not: chat and Slack both retrieve
  // against the agent's documents and the routine path did not, so the same
  // agent read the company's own handbook when asked a question and had
  // forgotten it when it wrote the digest.

  it("grounds the summary in the agent's own documents", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    retrieve = vi.fn(async () => ({
      ragBlock: "Excerpt: our own pricing page lists Pro at $29.",
      embeddingTokens: 0,
    }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    expect(summarise.mock.calls[0][0].ragBlock).toContain("Pro at $29");
  });

  it("retrieves against the instruction and what this run actually found", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    const r = routine({
      instruction: "Flag anything about competitor pricing",
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const [call] = retrieve.mock.calls;
    expect(call[0].agentId).toBe("a1");
    // Both halves: the standing instruction, and the entries this particular
    // run is about. A query built from the instruction alone returns the same
    // passages every run, whatever came in.
    expect(call[0].query).toContain("Flag anything about competitor pricing");
    expect(call[0].query).toContain("Tb");
  });

  it("charges the embedding tokens to the owner alongside the completion's", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    retrieve = vi.fn(async () => ({ ragBlock: "block", embeddingTokens: 900 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    // The completion and the embedding, in one write.
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(45), E(900)] }]);
  });

  it("still delivers, ungrounded, when retrieval throws", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    retrieve = vi.fn(async () => {
      throw new Error("embeddings unavailable");
    });
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    // An ungrounded digest beats no digest — the same trade retrieval.ts makes
    // for a chat turn.
    expect(out.status).toBe("ok");
    expect(summarise.mock.calls[0][0].ragBlock).toBe("");
    expect(deliverCalls).toHaveLength(1);
  });

  it("does not pay to retrieve for a run that has nothing to report", async () => {
    fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: '"v1"', contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    expect(retrieve).not.toHaveBeenCalled();
  });

  // ---- watching a connection -----------------------------------------------

  it("reads a connection's documents instead of fetching anything", async () => {
    fetchImpl = vi.fn();
    const { db } = makeDb({
      documents: [
        {
          id: "d1",
          name: "Handbook",
          content: "Holiday policy is twenty-five days.",
          external_url: "https://notion.so/handbook",
          external_version: "v2",
          synced_at: "2026-09-05T10:00:00Z",
        },
      ],
    });
    const r = routine({
      source_kind: "connection",
      source_config: { connectionId: "cn1" },
      cursor: { seenKeys: ["d1:v1"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out).toEqual({ status: "ok", itemsNew: 1 });
    // The whole design: no provider call, no second token decrypt, nothing
    // added to the sync's subrequest budget.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summarise.mock.calls[0][0].items[0].title).toBe("Handbook");
  });

  it("says nothing on a connection routine's first run", async () => {
    fetchImpl = vi.fn();
    const { db, updates } = makeDb({
      documents: [{ id: "d1", name: "Handbook", external_version: "v1", synced_at: "2026-09-05" }],
    });
    const r = routine({
      source_kind: "connection",
      source_config: { connectionId: "cn1" },
      cursor: null,
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    // Same rule as a feed: with no cursor there is nothing to compare against,
    // so the baseline is recorded and the whole bundle is not posted at anyone.
    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(deliverCalls).toHaveLength(0);
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.cursor.seenKeys).toEqual(["d1:v1"]);
  });

  it("fails a connection routine whose connection is not in its workspace", async () => {
    fetchImpl = vi.fn();
    const { db, updates } = makeDb({ rows: { connections: null } });
    const r = routine({
      source_kind: "connection",
      source_config: { connectionId: "cn-elsewhere" },
      cursor: { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out.status).toBe("failed");
    expect(deliverCalls).toHaveLength(0);
    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.consecutive_failures).toBe(1);
  });

  // ---- what the cap declined -----------------------------------------------

  it("records the entries the per-run cap dropped", async () => {
    // Twelve unseen entries against a cap of ten.
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    fetchImpl = vi.fn(async () => new Response(ATOM(ids), { status: 200 }));
    const { db, inserts } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["z"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out).toEqual({ status: "ok", itemsNew: 10 });
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.items_new).toBe(10);
    // The two the cap declined are marked seen and never delivered later, so a
    // run that does not record this number has lost it.
    expect(run.values.items_overflow).toBe(2);
  });

  it("tells the reader what was left out of the message", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    fetchImpl = vi.fn(async () => new Response(ATOM(ids), { status: 200 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["z"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const sent = JSON.parse(deliverCalls[0].init.body).text;
    expect(sent).toContain("2 further entries were not included");
  });

  it("leaves the message alone when nothing was dropped", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    expect(JSON.parse(deliverCalls[0].init.body).text).not.toContain("not included");
    expect(inserts.find((i) => i.table === "routine_runs")!.values.items_overflow).toBe(0);
  });

  // ---- deciding not to send ------------------------------------------------
  //
  // Every run with new entries used to deliver. Point a routine at a general
  // news feed and ask for competitor news, and most runs are six unrelated
  // posts plus a paragraph saying none of them are about competitors — hourly,
  // in a channel, until it is muted. The routine keeps working and stops being
  // read, which is the failure that does not show up anywhere.

  const declines = () => {
    summarise = vi.fn(async () => ({ text: "", tokens: 120, spend: [S(45)], declined: true }));
  };

  it("sends nothing when the model found nothing worth sending", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
    declines();
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    const out = await runRoutine(r, makeDeps(db) as any);

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(deliverCalls).toHaveLength(0);
  });

  it("records how many entries it reviewed before deciding", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
    declines();
    const { db, inserts } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.status).toBe("skipped");
    // Two new entries were read and judged. A row reading 0 would be
    // indistinguishable from a feed that had not moved, which is the question
    // this number exists to answer.
    expect(run.values.items_new).toBe(2);
    expect(run.values.error).toBe(NOTHING_RELEVANT_REASON);
    // Nothing was delivered, so there is nothing to show under the row.
    expect(run.values.summary).toBeNull();
  });

  it("advances the cursor, so a rejected entry is not judged again", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
    declines();
    const { db, updates } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.cursor.seenKeys).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("still charges the call that produced the decision", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    declines();
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    // Silence is cheaper in noise, not in tokens: the model call that decided
    // this is the model call that cost money.
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(45)] }]);
  });

  it("does not count as a failure", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    declines();
    const { db, updates } = makeDb();
    const r = routine({
      consecutive_failures: 3,
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    // A run that looked and decided is a working run. Counting it would pause a
    // healthy routine after five quiet ones.
    expect(updates.find((u) => u.table === "routines")!.values.consecutive_failures).toBe(0);
  });

  it("never lets a scheduled prompt decline", async () => {
    fetchImpl = vi.fn();
    const { db } = makeDb();

    await runRoutine(routine({ source_kind: "none", source_config: {} }), makeDeps(db) as any);

    // Nothing to be irrelevant to, and one `false` would silence it forever.
    expect(summarise.mock.calls[0][0].mayDecline).toBe(false);
  });

  it("lets a routine that watches something decline", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    expect(summarise.mock.calls[0][0].mayDecline).toBe(true);
  });
});

/**
 * Filing, which is the optional half of a run and is never allowed to be the
 * half that breaks it.
 *
 * Every test here is really the same assertion from a different angle: the
 * message went out, so the run is `ok`, whatever happened afterwards. The
 * reason that matters is in `canFileDocuments` — an exception on this path
 * would be recorded as a failure, backed off geometrically, and at
 * `MAX_FAILURES` would pause a routine that is delivering perfectly.
 */
describe("runRoutine filing", () => {
  const filed = (over: Partial<RoutineRow> = {}) =>
    routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
      output_bundle_id: "b1",
      output_retention: 12,
      ...over,
    });

  function depsWithFile(db: any, file: any) {
    return { ...makeDeps(db), file };
  }

  it("does not reach for the filing code at all when the routine files nothing", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb();
    const file = vi.fn();

    const r = routine({
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
    });
    const out = await runRoutine(r, depsWithFile(db, file) as any);

    expect(out.status).toBe("ok");
    expect(file).not.toHaveBeenCalled();
    // And says nothing about it. A note here would put an explanation in front
    // of everybody whose routine simply does not file, which is almost everybody.
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.document_id).toBeNull();
    expect(run.values.filing_note).toBeNull();
  });

  it("files exactly what was delivered, overflow note and all", async () => {
    // Twelve new entries against a per-run cap of ten, so the delivered text
    // carries the sentence saying two were dropped.
    fetchImpl = vi.fn(
      async () =>
        new Response(ATOM(["a", ...Array.from({ length: 12 }, (_, i) => `n${i}`)]), {
          status: 200,
        }),
    );
    const { db, inserts } = makeDb();
    const file = vi.fn(async () => ({ filed: true, documentId: "d1", indexTokens: 0 }));

    await runRoutine(filed(), depsWithFile(db, file) as any);

    expect(file).toHaveBeenCalledTimes(1);
    const [input] = file.mock.calls[0] as any[];
    expect(input.bundleId).toBe("b1");
    expect(input.retention).toBe(12);
    expect(input.routineId).toBe("r1");
    expect(input.workspaceId).toBe("w1");
    // The filed copy is not the tidier one. A digest that was missing entries
    // is still missing them a year later.
    expect(input.summary).toContain("were not included");
    expect(inserts.find((i) => i.table === "routine_runs")!.values.document_id).toBe("d1");
  });

  it("charges the filing embeddings with the run's other spend, not separately", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    const file = vi.fn(async () => ({ filed: true, documentId: "d1", indexTokens: 800 }));

    await runRoutine(filed(), depsWithFile(db, file) as any);

    // One record() call for the whole run: the completion and the filing
    // embeddings together.
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(45), E(800, "index")] }]);
  });

  it("keeps delivering and stops filing when the owner is only a viewer", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb({
      rows: { workspace_members: { user_id: "u1", role: "viewer" } },
    });
    const file = vi.fn();

    const out = await runRoutine(filed(), depsWithFile(db, file) as any);

    // Delivering is reading and a viewer may read. This is the whole
    // distinction: the mail keeps arriving, the knowledge base stops growing.
    expect(out.status).toBe("ok");
    expect(deliverCalls).toHaveLength(1);
    expect(file).not.toHaveBeenCalled();
    expect(inserts.find((i) => i.table === "routine_runs")!.values.filing_note).toContain("viewer");
  });

  it("says which deployment is missing what when no document store is bound", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts } = makeDb();

    // `file` absent, which is what the dispatcher hands over on a cron Worker
    // with no R2 binding — the ordinary state of it on Cloudflare.
    const out = await runRoutine(filed(), makeDeps(db) as any);

    expect(out.status).toBe("ok");
    const run = inserts.find((i) => i.table === "routine_runs")!;
    expect(run.values.document_id).toBeNull();
    expect(run.values.filing_note).toContain("document storage");
  });

  it("records a refusal to file without failing the run", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts, updates } = makeDb();
    const file = vi.fn(async () => ({ filed: false, note: "not filed: the bundle is gone" }));

    const out = await runRoutine(filed(), depsWithFile(db, file) as any);

    expect(out.status).toBe("ok");
    expect(inserts.find((i) => i.table === "routine_runs")!.values.filing_note).toBe(
      "not filed: the bundle is gone",
    );
    // The failure counter is what eventually pauses a routine. Nothing about
    // filing may touch it.
    expect(updates.find((u) => u.table === "routines")!.values.consecutive_failures).toBe(0);
  });

  it("survives a filing implementation that throws, which the contract forbids", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db, inserts, updates } = makeDb();
    const file = vi.fn(async () => {
      throw new Error("R2 said no");
    });

    const out = await runRoutine(filed(), depsWithFile(db, file) as any);

    // `fileRoutineOutput` is documented never to throw. This is about the
    // injected dependency rather than that one: a future implementation that
    // forgets the contract must not be able to pause a working routine.
    expect(out.status).toBe("ok");
    expect(inserts.find((i) => i.table === "routine_runs")!.values.filing_note).toContain(
      "R2 said no",
    );
    expect(updates.find((u) => u.table === "routines")!.values.consecutive_failures).toBe(0);
  });

  it("files nothing when the model declined to send anything", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b"]), { status: 200 }));
    const { db } = makeDb();
    summarise = vi.fn(async () => ({ text: "", tokens: 90, spend: [S(30)], declined: true }));
    const file = vi.fn();

    await runRoutine(filed(), depsWithFile(db, file) as any);

    // Nothing was delivered, so there is nothing that was worth keeping. A
    // filed record of "nothing relevant this week" fifty-two times a year is
    // noise an agent would then retrieve.
    expect(file).not.toHaveBeenCalled();
  });
});

/**
 * The branch that lets a scheduled run use the tools a chat turn has.
 *
 * `runWithTools` is an injected dependency for the same reason `summarise` is,
 * and the shape of the contract is the interesting part: it answers `null`
 * when this workspace has nothing for a tool to point at, and `null` is what
 * sends the run back down the single-call path every routine used before this
 * existed. One question asked once, rather than a separate "does it have
 * tools" lookup and then a second call.
 */
describe("a run that can use tools", () => {
  it("does not touch summarise when the tool path answered", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const runWithTools = vi.fn(async () => ({
      text: "I queried the orders database.",
      tokens: 300,
      declined: false,
    }));

    await runRoutine(routine({ cursor: { seen: ["a"] } as never }), {
      ...(makeDeps(db) as Record<string, unknown>),
      runWithTools,
    } as never);

    expect(runWithTools).toHaveBeenCalledTimes(1);
    expect(summarise).not.toHaveBeenCalled();
    expect(deliverCalls[0].init.body).toContain("I queried the orders database.");
  });

  it("gives it the three ids a tool needs, which never come from the model", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const runWithTools = vi.fn(async (input: Record<string, unknown>) => {
      seen = input;
      return { text: "done", tokens: 1, declined: false };
    });
    let seen: Record<string, unknown> | null = null;

    await runRoutine(routine({ cursor: { seen: ["a"] } as never }), {
      ...(makeDeps(db) as Record<string, unknown>),
      runWithTools,
    } as never);

    expect(seen).toMatchObject({
      agentId: "a1",
      workspaceId: "w1",
      userId: "u1",
    });
  });

  it("falls back to the single call when the workspace has no service connected", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const runWithTools = vi.fn(async () => null);

    await runRoutine(routine({ cursor: { seen: ["a"] } as never }), {
      ...(makeDeps(db) as Record<string, unknown>),
      runWithTools,
    } as never);

    expect(runWithTools).toHaveBeenCalledTimes(1);
    expect(summarise).toHaveBeenCalledTimes(1);
    expect(deliverCalls[0].init.body).toContain("summary");
  });

  it("still lets a run decide it has nothing worth sending", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const runWithTools = vi.fn(async () => ({
      text: "",
      tokens: 90,
      spend: [S(30)],
      declined: true,
    }));

    const out = await runRoutine(routine({ cursor: { seen: ["a"] } as never }), {
      ...(makeDeps(db) as Record<string, unknown>),
      runWithTools,
    } as never);

    expect(out.status).toBe("skipped");
    expect(deliverCalls).toHaveLength(0);
    // Charged anyway. A run that read its material and decided against
    // sending has spent what it spent.
    expect(recorded[0]).toEqual({ workspaceId: "w1", spend: [S(30)] });
  });

  it("charges what the whole loop cost, not what one call did", async () => {
    fetchImpl = vi.fn(async () => new Response(ATOM(["a"]), { status: 200 }));
    const { db } = makeDb();
    const runWithTools = vi.fn(async () => ({
      text: "done",
      tokens: 940,
      spend: [S(310)],
      declined: false,
    }));

    await runRoutine(routine({ cursor: { seen: ["a"] } as never }), {
      ...(makeDeps(db) as Record<string, unknown>),
      runWithTools,
    } as never);

    expect(recorded[0]).toEqual({ workspaceId: "w1", spend: [S(310)] });
  });
});

describe("a routine that ends", () => {
  // `source_kind: "none"` throughout: these tests are about what `finish` does
  // with an outcome, not about how a source produced one, and "none" reaches
  // every outcome below without a feed or a cursor to set up.
  const endingRoutine = (over: Partial<RoutineRow> = {}) =>
    routine({ source_kind: "none", source_config: {}, ...over });

  /** Delivers: `summarise` answers, declines nothing, so the run is `ok`. */
  function depsThatDeliver() {
    fetchImpl = vi.fn();
    summarise = vi.fn(async () => ({
      text: "summary",
      tokens: 120,
      spend: [S(45)],
      declined: false,
    }));
    const { db, updates } = makeDb();
    return { deps: makeDeps(db) as any, updates };
  }

  /** Fails: `summarise` throws, so the run lands in `finish` as `"failed"`. */
  function depsThatFail(reason = "boom") {
    fetchImpl = vi.fn();
    summarise = vi.fn(async () => {
      throw new Error(reason);
    });
    const { db, updates } = makeDb();
    return { deps: makeDeps(db) as any, updates };
  }

  /** Skips: the model read the material and declined to send anything. */
  function depsThatSkip() {
    fetchImpl = vi.fn();
    summarise = vi.fn(async () => ({
      text: "",
      tokens: 120,
      spend: [S(45)],
      declined: true,
    }));
    const { db, updates } = makeDb();
    return { deps: makeDeps(db) as any, updates };
  }

  it("counts a delivered run", async () => {
    const r = endingRoutine({ ends_after_runs: 7, runs_done: 2 });
    const { deps, updates } = depsThatDeliver();

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values).toMatchObject({ runs_done: 3 });
    expect(saved.values.status).toBeUndefined();
  });

  it("does not count a failed run", async () => {
    const r = endingRoutine({ ends_after_runs: 7, runs_done: 2 });
    const { deps, updates } = depsThatFail();

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.runs_done).toBeUndefined();
  });

  it("does not count a skipped run", async () => {
    const r = endingRoutine({ ends_after_runs: 7, runs_done: 2 });
    const { deps, updates } = depsThatSkip();

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.runs_done).toBeUndefined();
  });

  // The headline case 0074's own header is written around: "a week of a dead
  // delivery channel would otherwise complete a seven-morning series that
  // nobody ever read." An `rss` source that has not moved never reaches
  // `summarise` at all — `result.status === "unchanged"` skips straight to
  // `finish` — so this exercises the same `"ok"` gate through the one path
  // that is actually the risk the spec names, not through `source_kind:
  // "none"` the way every other test in this block does.
  it("does not count a run whose feed came back unchanged", async () => {
    fetchImpl = vi.fn(async () => res("", { status: 304 }));
    const { db, updates } = makeDb();
    const r = routine({
      ends_after_runs: 7,
      runs_done: 2,
      cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: '"v1"', contentHash: null },
    });

    await runRoutine(r, makeDeps(db) as any);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.runs_done).toBeUndefined();
  });

  it("finishes on the last delivered run", async () => {
    const r = endingRoutine({ ends_after_runs: 7, runs_done: 6 });
    const { deps, updates } = depsThatDeliver();

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values).toMatchObject({ runs_done: 7, status: "completed" });
  });

  it("leaves a routine with no end alone", async () => {
    const r = endingRoutine({ ends_after_runs: null, runs_done: 0 });
    const { deps, updates } = depsThatDeliver();

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.runs_done).toBeUndefined();
    expect(saved.values.status).toBeUndefined();
  });

  /**
   * A pause wins. A run that both delivered and hit a condition that stops the
   * routine should read as stopped-for-a-reason, not finished — "finished" is
   * a claim that the series ran its course.
   *
   * Nothing in this file can make `runRoutine` produce an `"ok"` outcome
   * carrying a pause at the same time — `pausedByFailures` only ever fires on
   * a `"failed"` outcome, and the membership pause always skips. So this
   * exercises the combination that actually happens: a run that fails right
   * at the failure cap pauses, on a routine that happens to be due for
   * completion by its count alone. `runs_done` is untouched (the `"ok"` gate
   * above never opens) and `status` reads "paused", never "completed".
   */
  it("does not call a paused run finished", async () => {
    const r = endingRoutine({
      ends_after_runs: 7,
      runs_done: 6,
      consecutive_failures: MAX_FAILURES - 1,
    });
    const { deps, updates } = depsThatFail("the workspace turned it off");

    await runRoutine(r, deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values.status).toBe("paused");
    expect(saved.values.paused_reason).toBe("the workspace turned it off");
    expect(saved.values.runs_done).toBeUndefined();
  });
});

describe("a routine that reads its own workspace", () => {
  // `source_config.report` names which report — only `coverage_gaps` exists
  // today (0075) — and nothing here reads it; the executor hands the whole
  // input off to `deps.coverage` and lets the dispatcher's real binding care
  // which report that is.
  //
  // Weekly, as the `gap-report` template is: the window is derived from the
  // schedule (covan-cloud#307), and the fixture's own quarter-hourly default
  // would make every run below a one-day report.
  const workspaceRoutine = (over: Partial<RoutineRow> = {}) =>
    routine({
      source_kind: "workspace",
      source_config: { report: "coverage_gaps" },
      schedule_cron: "0 9 * * 1",
      ...over,
    });

  function depsForWorkspaceRun(over: Parameters<typeof makeDb>[0] = {}) {
    fetchImpl = vi.fn();
    const { db, updates, inserts, claimed, released } = makeDb(over);
    const deps = makeDeps(db) as any;
    return { deps, updates, inserts, claimed, released };
  }

  it("delivers the rendered report and makes no summarise call", async () => {
    const { deps, inserts } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({
      kind: "report",
      summary: "Over the last 7 days…",
      model: "gpt-4.1-mini",
      tokens: 900,
    });

    const out = await runRoutine(workspaceRoutine(), deps);

    expect(out).toEqual({ status: "ok", itemsNew: 1 });
    expect(summarise).not.toHaveBeenCalled();
    expect(deps.coverage).toHaveBeenCalledWith(
      { workspaceId: "w1", ownerId: "u1", days: 7 },
      expect.anything(),
    );
    expect(deliverCalls).toHaveLength(1);
    expect(JSON.parse(deliverCalls[0].init.body).text).toContain("Over the last 7 days");
    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    expect(run.status).toBe("ok");
  });

  it("records the clustering call as the run's model call", async () => {
    const { deps, inserts } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({
      kind: "report",
      summary: "x",
      model: "gpt-4.1-mini",
      tokens: 900,
      // Deliberately not 900 — see the default `summarise` above.
      spend: [S(320)],
    });

    await runRoutine(workspaceRoutine(), deps);

    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    // `routine_runs.tokens` is the raw count that moved.
    expect(run).toMatchObject({ status: "ok", model: "gpt-4.1-mini", tokens: 900 });
    // The ledger is told what was consumed, not the raw count.
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(320)] }]);
  });

  it("pauses the routine when the run says it may not continue", async () => {
    const { deps, updates } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({
      kind: "pause",
      // The real string `coverage-source.ts` returns today, not the brief's
      // "no longer turned on" — Task 12 changed it because the brief's own
      // assertion regex did not match the brief's own string.
      reason: "the coverage report is no longer on for this workspace",
    });

    await runRoutine(workspaceRoutine(), deps);

    const saved = updates.find((u) => u.table === "routines")!;
    expect(saved.values).toMatchObject({
      status: "paused",
      paused_reason: "the coverage report is no longer on for this workspace",
    });
  });

  /**
   * Item 3 of the review. `announcePause`'s own wording — "paused after
   * repeated failures" — is false for all three of this feature's reasons,
   * so the notice this pause actually sends has to come from somewhere else.
   * Asserted on the notice `deliver()` actually sent, not on which function
   * got called, because the thing that matters is what lands in the owner's
   * inbox.
   */
  it("tells the owner honestly why it stopped, not that it failed repeatedly", async () => {
    const { deps } = depsForWorkspaceRun();
    const reason =
      "a workspace needs at least three people before a topic can be reported " +
      "without identifying who asked";
    deps.coverage = vi.fn().mockResolvedValue({ kind: "pause", reason });

    await runRoutine(workspaceRoutine(), deps);

    expect(deliverCalls).toHaveLength(1);
    const body = deliverCalls[0].init.body as string;
    expect(body).not.toMatch(/repeated failures/);
    expect(body).toContain(reason);
  });

  it("skips without delivering when there is nothing to report", async () => {
    const { deps, inserts } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({ kind: "skip", note: "nothing fell short" });

    await runRoutine(workspaceRoutine(), deps);

    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    expect(run.status).toBe("skipped");
    // The pre-call skip: nothing was spent finding out there was nothing to
    // report, and this must stay metered as nothing.
    expect(run.tokens).toBe(0);
    expect(deliverCalls).toHaveLength(0);
    expect(recorded).toEqual([]);
  });

  /**
   * Item 2 of the review. This is the skip that follows the clustering call —
   * every cluster fell short of the floor — and it is the one the brief's own
   * Step 3 code left unmetered. `coverage-source.ts` reports what it spent;
   * this run must bill it, the same as a declined summarise run does.
   */
  it("meters a skip that followed the clustering call, not one that came before it", async () => {
    const { deps, inserts } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({
      kind: "skip",
      note: "no one topic came from 3 or more different people",
      model: "gpt-4.1-mini",
      tokens: 640,
      // Deliberately not 640 — see the comment on the test above.
      spend: [S(230)],
    });

    await runRoutine(workspaceRoutine(), deps);

    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    expect(run).toMatchObject({ status: "skipped", model: "gpt-4.1-mini", tokens: 640 });
    expect(recorded).toEqual([{ workspaceId: "w1", spend: [S(230)] }]);
    expect(deliverCalls).toHaveLength(0);
  });

  /**
   * Fix round 1, finding A3. The workspace branch used to claim no
   * idempotency key before sending, so a worker that died between delivering
   * and `finish` — reclaimed by `claim_due_routines` past its stale-claim
   * window (0055:82) — or a manual run overlapping a scheduled one
   * (`runOneRoutine` bypasses claiming by design) could deliver the same
   * report twice. `claimWins: () => []` models the key having already been
   * claimed by whichever run got there first.
   *
   * covan-cloud#308: and it now finds that out before the clustering call,
   * not after it — a duplicate used to pay for one call and then skip.
   */
  it("delivers nothing a second time for the same slot, and spends nothing finding out", async () => {
    const { deps, inserts } = depsForWorkspaceRun({ claimWins: () => [] });
    deps.coverage = vi.fn().mockResolvedValue({
      kind: "report",
      summary: "Over the last 7 days…",
      model: "gpt-4.1-mini",
      tokens: 900,
      spend: [S(320)],
    });

    const out = await runRoutine(workspaceRoutine(), deps);

    expect(out).toEqual({ status: "skipped", itemsNew: 0 });
    expect(deps.coverage).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    expect(run.status).toBe("skipped");
    expect(run.tokens).toBe(0);
    expect(run.model).toBeNull();
    expect(recorded).toEqual([]);
  });

  describe("the slot key, claimed before the outcome is known (covan-cloud#308)", () => {
    it("is claimed before the clustering call runs", async () => {
      const { deps, claimed } = depsForWorkspaceRun();
      let claimedWhenCalled: string[] | null = null;
      deps.coverage = vi.fn().mockImplementation(async () => {
        claimedWhenCalled = [...claimed];
        return { kind: "skip", note: "nothing fell short" };
      });

      await runRoutine(workspaceRoutine(), deps);

      expect(claimedWhenCalled).toEqual(["slot:2026-08-14T10:00:00.000Z"]);
    });

    it("stays claimed on a skip, which is this slot's answer", async () => {
      const { deps, released } = depsForWorkspaceRun();
      deps.coverage = vi.fn().mockResolvedValue({
        kind: "skip",
        note: "no one topic came from 3 or more different people",
        model: "gpt-4.1-mini",
        tokens: 640,
        spend: [S(230)],
      });

      await runRoutine(workspaceRoutine(), deps);

      expect(released).toEqual([]);
    });

    it("is handed back on a pause, which is not an answer for the slot", async () => {
      // A webhook's key, because that is the one that outlives the run: a
      // slot key is dead once `finish` advances `next_run_at`, and a
      // redelivery of this event after the routine is resumed must not be
      // refused as already handled.
      const { deps, released, updates } = depsForWorkspaceRun();
      deps.coverage = vi.fn().mockResolvedValue({
        kind: "pause",
        reason: "the coverage report is no longer on for this workspace",
      });

      await runRoutine(workspaceRoutine(), deps, { eventId: "evt-1", payload: "{}" });

      expect(released).toEqual(["hook:evt-1"]);
      expect(updates.find((u) => u.table === "routines")!.values.status).toBe("paused");
    });

    it("is handed back when the run throws", async () => {
      const { deps, released, inserts } = depsForWorkspaceRun();
      deps.coverage = vi.fn().mockRejectedValue(new Error("readGaps failed"));

      await runRoutine(workspaceRoutine(), deps);

      expect(released).toEqual(["slot:2026-08-14T10:00:00.000Z"]);
      expect(inserts.find((i) => i.table === "routine_runs")!.values.status).toBe("failed");
    });

    it("stays claimed once the report is delivered", async () => {
      const { deps, released } = depsForWorkspaceRun();
      deps.coverage = vi.fn().mockResolvedValue({
        kind: "report",
        summary: "x",
        model: "gpt-4.1-mini",
        tokens: 900,
      });

      await runRoutine(workspaceRoutine(), deps);

      expect(deliverCalls).toHaveLength(1);
      expect(released).toEqual([]);
    });
  });

  /**
   * covan-cloud#307. The window was seven days whatever the schedule said, so
   * an owner who edited the weekly template to daily got a daily email of the
   * same rolling week.
   */
  it("reads the routine's own period, not a fixed week", async () => {
    const { deps } = depsForWorkspaceRun();
    deps.coverage = vi.fn().mockResolvedValue({ kind: "skip", note: "nothing fell short" });

    await runRoutine(workspaceRoutine({ schedule_cron: "0 9 * * *" }), deps);

    expect(deps.coverage).toHaveBeenCalledWith(
      { workspaceId: "w1", ownerId: "u1", days: 1 },
      expect.anything(),
    );
  });

  it("fails loudly rather than silently when no coverage dep is bound", async () => {
    const { deps, inserts } = depsForWorkspaceRun();
    deps.coverage = undefined;

    await runRoutine(workspaceRoutine(), deps);

    const run = inserts.find((i) => i.table === "routine_runs")!.values;
    expect(run.status).toBe("failed");
  });
});
