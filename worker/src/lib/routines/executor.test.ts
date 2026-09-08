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
import type { WorkspaceKeys } from "../keys/store";

// Task 11 wires a real DNS lookup into the Node fetch path so a hostname that
// merely resolves to a private address is still caught. That lookup is a
// dynamic `import("node:dns/promises")`, which vi.mock intercepts the same as
// a static one. Stub it so these tests keep exercising the fixture hostname
// "e.com" without depending on a real network round trip — the same reason
// fetchImpl itself is mocked rather than left to hit the network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

// `keysForUser` reaches the workspace's stored key through `lib/keys/store`,
// which opens a service-role Supabase client of its own rather than taking the
// `deps.db` stub below — there is nothing here to point it at. Mocked to "no
// key set", which is what every test in this file wants except the
// workspace-funded one at the bottom, which says otherwise for itself.
const { readWorkspaceKeys } = vi.hoisted(() => ({
  readWorkspaceKeys: vi.fn(async () => ({ openai: null, anthropic: null }) as WorkspaceKeys),
}));
vi.mock("../keys/store", () => ({ readWorkspaceKeys }));

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

  const rowFor = async (table: string) => {
    if (over.rows && table in over.rows) return over.rows[table];
    if (table === "workspace_members") return { user_id: "u1" };
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
let retrieve: any;
let deliverCalls: any[];
/** Tokens charged through `entitlements.record`, per run. */
let recorded: Array<{ userId: string; tokens: number }>;

function makeDeps(db: any) {
  deliverCalls = [];
  recorded = [];
  return {
    db,
    // A plain house env — none of these tests exercise a workspace key, so this
    // only has to be a shape `keysForUser` can read without a workspace lookup.
    env: { OPENAI_API_KEY: "sk-test" },
    summarise,
    retrieve,
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
  summarise = vi.fn(async () => ({ text: "summary", tokens: 120, declined: false }));
  // Ungrounded by default, so the assertions below are about what the executor
  // does with a block rather than about whether one was produced. The tests
  // that care override this.
  retrieve = vi.fn(async () => ({ ragBlock: "", embeddingTokens: 0 }));
  // Reset rather than clear: a mockResolvedValue installed by one test would
  // otherwise become the de-facto default for every test after it.
  readWorkspaceKeys.mockReset();
  readWorkspaceKeys.mockResolvedValue({ openai: null, anthropic: null });
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

  /**
   * The workspace-funded branch, on the path with no request to guard.
   *
   * `guardQuota` covers this for every route that has a request; a scheduled
   * routine has none, so the same three-branch decision is made here by hand
   * and is the one a refactor is most likely to get wrong quietly. The two
   * halves are a pair on purpose: running on the wrong key spends the wrong
   * person's money, and recording a workspace-funded run against the operator's
   * counter bills the operator for money they did not spend. Either alone is
   * still a defect.
   */
  describe("when the owner is out but their workspace has a key", () => {
    /** A db where `getActiveWorkspaceId` resolves, so a key can be looked up. */
    const workspaceDb = () =>
      makeDb({
        rows: {
          profiles: { active_workspace_id: "w1" },
          workspace_members: { user_id: "u1", workspace_id: "w1" },
        },
      });

    const outOfAllowance = (deps: any) => {
      deps.entitlements.check = vi.fn(async () => ({
        allowed: false,
        used: 100_000,
        limit: 100_000,
        resetsAt: "2026-10-01T00:00:00.000Z",
      }));
      return deps;
    };

    it("runs the summary on the workspace's key rather than skipping", async () => {
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: null });
      const { db } = workspaceDb();
      const deps = outOfAllowance(makeDeps(db) as any);

      const out = await runRoutine(
        routine({
          cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
        }),
        deps,
      );

      expect(out).toEqual({ status: "ok", itemsNew: 2 });
      // The second argument is the env the model call is made with. It has to
      // be the overlay, not `deps.env` — the operator's key answering here
      // would be the operator paying for a run their allowance already refused.
      expect(summarise.mock.calls[0][1].OPENAI_API_KEY).toBe("ws-openai");
      // And nothing about the skip: no quota notice, one real delivery.
      expect(deliverCalls).toHaveLength(1);
    });

    it("writes nothing to the operator's counter for what the workspace paid", async () => {
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      readWorkspaceKeys.mockResolvedValue({ openai: "ws-openai", anthropic: null });
      const { db, inserts } = workspaceDb();
      const deps = outOfAllowance(makeDeps(db) as any);

      await runRoutine(
        routine({
          cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
        }),
        deps,
      );

      expect(deps.entitlements.record).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
      // Still durably recorded where the team can see it, though — the counter
      // is not the only record of a spend, and `routine_runs.tokens` is what
      // the usage screen's per-agent figures are built from.
      const run = inserts.find((i) => i.table === "routine_runs")!;
      expect(run.values.tokens).toBe(120);
    });

    it("still charges the operator when the key came from the operator", async () => {
      // The control. Same denied verdict, same code path, no workspace key —
      // and the run is skipped rather than quietly funded by anybody.
      fetchImpl = vi.fn(async () => new Response(ATOM(["a", "b", "c"]), { status: 200 }));
      const { db } = workspaceDb();
      const deps = outOfAllowance(makeDeps(db) as any);

      const out = await runRoutine(
        routine({
          cursor: { seenKeys: ["a"], lastPublishedAt: null, etag: null, contentHash: null },
        }),
        deps,
      );

      expect(out).toEqual({ status: "skipped", itemsNew: 0 });
      expect(summarise).not.toHaveBeenCalled();
    });
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

    // 120 from the completion, plus 900 embedding tokens at EMBEDDING_TOKEN_WEIGHT.
    expect(recorded).toEqual([{ userId: "u1", tokens: 129 }]);
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
    summarise = vi.fn(async () => ({ text: "", tokens: 120, declined: true }));
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
    expect(recorded).toEqual([{ userId: "u1", tokens: 120 }]);
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
