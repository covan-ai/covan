import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { registerEntitlements, resetEntitlements, type Entitlements } from "../entitlements";
import type { ArrivalItem } from "./read";

/**
 * A scan, from the claim to the counts.
 *
 * The readers and the model are stubbed (their own tests cover them); the
 * database is `memoryDb`, so a conditional claim is really conditional. What
 * is under test is the life of the row: claimed once, finished once, failed
 * with a reason a person can read, retried by the tick when the isolate died,
 * and paid for in every one of those cases.
 */
let db: ReturnType<typeof memoryDb>;
vi.mock("../supabase", () => ({ serviceClient: () => db.db }));

const readSource = vi.fn();
vi.mock("./read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./read")>()),
  readSource: (...args: unknown[]) => readSource(...args),
}));

const classifyItems = vi.fn();
const labelBuckets = vi.fn();
vi.mock("./classify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./classify")>()),
  classifyItems: (...args: unknown[]) => classifyItems(...args),
  labelBuckets: (...args: unknown[]) => labelBuckets(...args),
}));

const { ArrivalReadError } = await import("./read");
const { BUCKET_RETENTION_DAYS, SCAN_MAX_ATTEMPTS, runArrivalScan, sweepArrivalScans } =
  await import("./scan");

const NOW = new Date("2026-10-26T09:00:00Z");
const ENV = {} as never;
const COMPLETION = {
  kind: "completion",
  model: "gpt-4.1-mini",
  promptTokens: 10,
  completionTokens: 2,
  purpose: "arrivals",
};

const recorded: Array<{ workspaceId: string; spends: unknown[]; ref: unknown }> = [];
let allowed = true;
const fake: Entitlements = {
  check: async () => (allowed ? { allowed: true } : { allowed: false, balance: 0 }),
  record: async (workspaceId, spends, ref) => {
    recorded.push({ workspaceId, spends, ref });
  },
  snapshot: async () => ({ metered: false }),
} as Entitlements;

function scan(over: Row = {}): Row {
  return {
    id: "scan-1",
    workspace_id: "ws-1",
    user_id: "u-1",
    status: "queued",
    taxonomy: 1,
    sources: [{ connection_id: "c-1", toolkit: "gmail" }],
    window_days: 30,
    total: null,
    unanswered: null,
    error: null,
    attempts: 0,
    lease_until: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-10-26T08:59:00.000Z",
    ...over,
  };
}

const CONNECTION: Row = {
  id: "c-1",
  workspace_id: "ws-1",
  created_by: "u-1",
  status: "active",
  transport: "composio",
  toolkit_slug: "gmail",
  connected_account_id: "ca_1",
  composio_user_id: "cu_1",
};

function mail(i: number, over: Partial<ArrivalItem> = {}): ArrivalItem {
  return {
    id: `t${i}`,
    source: "mail",
    domain: "acme.test",
    subject: `Subject ${i}`,
    snippet: "",
    at: "2026-10-20T08:00:00.000Z",
    fromMe: false,
    repliedByMe: false,
    ...over,
  };
}

function seed(scans: Row[], buckets: Row[] = [], connections: Row[] = [CONNECTION]) {
  db = memoryDb({
    arrival_scans: scans,
    arrival_buckets: buckets,
    tool_connections: connections,
    routines: [],
  });
}

beforeEach(() => {
  recorded.length = 0;
  allowed = true;
  registerEntitlements(() => fake);
  readSource.mockReset();
  classifyItems.mockReset();
  labelBuckets.mockReset();
  readSource.mockResolvedValue({
    items: [mail(0), mail(1), mail(2)],
    calls: ["GMAIL_FETCH_EMAILS"],
    selfDomains: ["covan.test"],
  });
  classifyItems.mockResolvedValue({
    kinds: ["question", "question", "admin"],
    spent: [COMPLETION],
  });
  labelBuckets.mockImplementation(async (_env, buckets) => ({
    buckets: buckets.map((b: Row) => ({
      ...b,
      label: b.kind === "question" ? "Order questions" : "",
    })),
    spent: [COMPLETION],
  }));
});

afterEach(() => resetEntitlements());

describe("runArrivalScan", () => {
  it("reads, counts and finishes the scan it claimed", async () => {
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);

    const [row] = db.tables.arrival_scans;
    expect(row).toMatchObject({
      status: "done",
      total: 3,
      unanswered: 2,
      attempts: 1,
      lease_until: null,
      error: null,
    });
    expect(typeof row.finished_at).toBe("string");
    expect(db.tables.arrival_buckets).toEqual([
      expect.objectContaining({
        scan_id: "scan-1",
        kind: "question",
        label: "Order questions",
        count: 2,
        unanswered: 2,
        template_id: "arrivals-questions",
      }),
      expect.objectContaining({
        scan_id: "scan-1",
        kind: "admin",
        label: "",
        count: 1,
        template_id: "arrivals-admin",
      }),
    ]);
    expect(readSource).toHaveBeenCalledWith(
      ENV,
      {
        connectionId: "c-1",
        toolkit: "gmail",
        account: { connectedAccountId: "ca_1", composioUserId: "cu_1" },
      },
      NOW,
    );
    expect(classifyItems.mock.calls[0][2]).toEqual({ selfDomains: ["covan.test"] });
  });

  // C1: a scan cut off by waitUntil is picked up by the tick within minutes.
  it("holds its lease for a minute and a half, not ten", async () => {
    classifyItems.mockRejectedValue(new Error("the model timed out"));
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0].lease_until).toBe(
      new Date(NOW.getTime() + 90_000).toISOString(),
    );
  });

  it("reads its sources at the same time", async () => {
    let release!: (v: unknown) => void;
    readSource
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce({ items: [], calls: ["GOOGLECALENDAR_EVENTS_LIST"], selfDomains: [] });
    seed(
      [
        scan({
          sources: [
            { connection_id: "c-1", toolkit: "gmail" },
            { connection_id: "c-3", toolkit: "googlecalendar" },
          ],
        }),
      ],
      [],
      [CONNECTION, { ...CONNECTION, id: "c-3", toolkit_slug: "googlecalendar" }],
    );
    const running = runArrivalScan(ENV, "scan-1", NOW);
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledTimes(2));
    release({ items: [mail(0)], calls: ["GMAIL_FETCH_EMAILS"], selfDomains: [] });
    await running;
    expect(db.tables.arrival_scans[0].status).toBe("done");
  });

  // I3: a new scan replaces the last one, and remembers what was turned on.
  it("carries a routine made from the last scan forward, and drops the last scan's rows", async () => {
    seed(
      [scan({ id: "old", status: "done", created_at: "2026-10-01T00:00:00.000Z" }), scan()],
      [
        {
          scan_id: "old",
          kind: "question",
          label: "",
          count: 4,
          unanswered: 1,
          examples: ["Old subject"],
          routine_id: "r-1",
        },
        {
          scan_id: "old",
          kind: "admin",
          label: "",
          count: 2,
          unanswered: 0,
          examples: [],
          routine_id: "r-gone",
        },
      ],
    );
    db.tables.routines = [
      { id: "r-1", deleted_at: null },
      { id: "r-gone", deleted_at: "2026-10-20T00:00:00.000Z" },
    ];
    await runArrivalScan(ENV, "scan-1", NOW);
    const kept = db.tables.arrival_buckets;
    expect(kept.every((b) => b.scan_id === "scan-1")).toBe(true);
    expect(kept.find((b) => b.kind === "question")?.routine_id).toBe("r-1");
    expect(kept.find((b) => b.kind === "admin")?.routine_id ?? null).toBeNull();
  });

  // I6: why a scan failed, as a code the report can say in words.
  it("says a scan failed for want of credits", async () => {
    allowed = false;
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0].reason).toBe("no_credit");
  });

  it("says a scan failed because the mailbox refused", async () => {
    readSource.mockRejectedValue(new ArrivalReadError("The grant has expired", [], 401));
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0].reason).toBe("source");
  });

  it("says a scan failed because nothing it may read is connected", async () => {
    seed([scan()], [], [{ ...CONNECTION, status: "pending" }]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0].reason).toBe("no_source");
  });

  it("pays for every model call and every Composio call, as the person who asked", async () => {
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(recorded).toEqual([
      {
        workspaceId: "ws-1",
        spends: [COMPLETION, COMPLETION, { kind: "composio_call", toolSlug: "GMAIL_FETCH_EMAILS" }],
        ref: { userId: "u-1" },
      },
    ]);
  });

  it("sends the label call the subjects of each kind, newest first", async () => {
    readSource.mockResolvedValue({
      items: [
        mail(0, { at: "2026-10-01T00:00:00.000Z" }),
        mail(1, { at: "2026-10-05T00:00:00.000Z" }),
        mail(2),
      ],
      calls: [],
      selfDomains: [],
    });
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    const subjects = labelBuckets.mock.calls[0][2] as Map<string, string[]>;
    expect(subjects.get("question")).toEqual(["Subject 1", "Subject 0"]);
  });

  it("says when it finished, not when it was claimed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW.getTime() + 20_000 });
    try {
      seed([scan()]);
      await runArrivalScan(ENV, "scan-1", NOW);
      expect(db.tables.arrival_scans[0].finished_at).toBe(
        new Date(NOW.getTime() + 20_000).toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failure's words short", async () => {
    readSource.mockRejectedValue(new ArrivalReadError("y".repeat(1000), [], 400));
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(String(db.tables.arrival_scans[0].error)).toHaveLength(200);
  });

  it("finishes an empty mailbox as nothing arrived, without naming anything", async () => {
    readSource.mockResolvedValue({ items: [], calls: ["GMAIL_FETCH_EMAILS"], selfDomains: [] });
    classifyItems.mockResolvedValue({ kinds: [], spent: [] });
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0]).toMatchObject({ status: "done", total: 0, unanswered: 0 });
    expect(db.tables.arrival_buckets).toEqual([]);
    expect(labelBuckets).not.toHaveBeenCalled();
  });

  it("fails at once, in Composio's words, when the mailbox refuses", async () => {
    readSource.mockRejectedValue(
      new ArrivalReadError("The grant has expired", ["GMAIL_FETCH_EMAILS"], 401),
    );
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0]).toMatchObject({
      status: "failed",
      error: "The grant has expired",
      lease_until: null,
    });
    expect(recorded[0].spends).toEqual([{ kind: "composio_call", toolSlug: "GMAIL_FETCH_EMAILS" }]);
  });

  it("leaves a scan that hit a passing failure for the tick to try again", async () => {
    classifyItems.mockRejectedValue(new Error("the model timed out"));
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    const [row] = db.tables.arrival_scans;
    expect(row).toMatchObject({ status: "running", attempts: 1 });
    expect(String(row.lease_until) > NOW.toISOString()).toBe(true);
    expect(recorded[0].spends).toEqual([{ kind: "composio_call", toolSlug: "GMAIL_FETCH_EMAILS" }]);
  });

  it("gives up on the last attempt", async () => {
    classifyItems.mockRejectedValue(new Error("the model timed out"));
    seed([
      scan({
        status: "running",
        attempts: SCAN_MAX_ATTEMPTS - 1,
        lease_until: "2026-10-26T08:00:00.000Z",
      }),
    ]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_scans[0]).toMatchObject({
      status: "failed",
      attempts: SCAN_MAX_ATTEMPTS,
    });
  });

  it("fails a scan whose credit hold is refused, without reading anything", async () => {
    const release = vi.fn(async () => {});
    registerEntitlements(
      () =>
        ({
          ...fake,
          reserve: async () => ({ allowed: false, balance: 0 }),
          release,
        }) as Entitlements,
    );
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(readSource).not.toHaveBeenCalled();
    expect(db.tables.arrival_scans[0]).toMatchObject({
      status: "failed",
      reason: "no_credit",
      lease_until: null,
    });
    expect(release).toHaveBeenCalledWith("arrivals:scan-1");
  });

  it("runs a scan whose credit hold is granted", async () => {
    registerEntitlements(
      () =>
        ({
          ...fake,
          reserve: async () => ({ allowed: true }),
          release: async () => {},
        }) as Entitlements,
    );
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(db.tables.arrival_scans[0].status).toBe("done");
  });

  it("reads nothing when the workspace has no credits", async () => {
    allowed = false;
    seed([scan()]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(readSource).not.toHaveBeenCalled();
    expect(db.tables.arrival_scans[0].status).toBe("failed");
    expect(String(db.tables.arrival_scans[0].error)).toMatch(/credits/);
  });

  it("does nothing to a scan that is finished, or held by a live lease", async () => {
    seed([
      scan({ status: "done" }),
      scan({
        id: "scan-2",
        status: "running",
        attempts: 1,
        lease_until: "2026-10-26T09:05:00.000Z",
      }),
    ]);
    await runArrivalScan(ENV, "scan-1", NOW);
    await runArrivalScan(ENV, "scan-2", NOW);
    expect(readSource).not.toHaveBeenCalled();
    expect(db.tables.arrival_scans.map((r) => r.status)).toEqual(["done", "running"]);
  });

  it("reads only connections that are the person's own, in the scan's workspace, and active", async () => {
    seed(
      [
        scan({
          sources: [
            { connection_id: "c-1", toolkit: "gmail" },
            { connection_id: "c-2", toolkit: "outlook" },
            { connection_id: "c-3", toolkit: "googlecalendar" },
          ],
        }),
      ],
      [],
      [
        CONNECTION,
        { ...CONNECTION, id: "c-2", toolkit_slug: "outlook", created_by: "u-2" },
        { ...CONNECTION, id: "c-3", toolkit_slug: "googlecalendar", status: "pending" },
      ],
    );
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(readSource.mock.calls[0][1].connectionId).toBe("c-1");
  });

  it("fails a scan with nothing it may read", async () => {
    seed([scan()], [], [{ ...CONNECTION, created_by: "u-2" }]);
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(readSource).not.toHaveBeenCalled();
    expect(db.tables.arrival_scans[0].status).toBe("failed");
  });

  it("replaces the buckets of an earlier attempt", async () => {
    seed(
      [scan({ status: "running", attempts: 1, lease_until: "2026-10-26T08:00:00.000Z" })],
      [{ scan_id: "scan-1", kind: "pitch", label: "", count: 9, unanswered: 0, examples: [] }],
    );
    await runArrivalScan(ENV, "scan-1", NOW);
    expect(db.tables.arrival_buckets.map((b) => b.kind)).toEqual(["question", "admin"]);
  });
});

describe("sweepArrivalScans", () => {
  it("runs a scan whose lease ran out, and one nobody started", async () => {
    seed([
      scan({
        id: "stalled",
        status: "running",
        attempts: 1,
        lease_until: "2026-10-26T08:50:00.000Z",
        created_at: "2026-10-26T08:30:00.000Z",
      }),
      scan({ id: "never", status: "queued", created_at: "2026-10-26T08:50:00.000Z" }),
      scan({ id: "live", status: "running", attempts: 1, lease_until: "2026-10-26T09:05:00.000Z" }),
      scan({ id: "fresh", status: "queued", created_at: "2026-10-26T08:59:50.000Z" }),
    ]);
    expect(await sweepArrivalScans(ENV, NOW)).toBe(true);
    let status = Object.fromEntries(db.tables.arrival_scans.map((r) => [r.id, r.status]));
    // One re-run per tick, the oldest first: a scan is up to ~20 subrequests.
    expect(status).toEqual({ stalled: "done", never: "queued", live: "running", fresh: "queued" });
    await sweepArrivalScans(ENV, NOW);
    status = Object.fromEntries(db.tables.arrival_scans.map((r) => [r.id, r.status]));
    expect(status).toEqual({ stalled: "done", never: "done", live: "running", fresh: "queued" });
  });

  it("gives up on a scan that has had all its attempts", async () => {
    seed([
      scan({
        status: "running",
        attempts: SCAN_MAX_ATTEMPTS,
        lease_until: "2026-10-26T08:50:00.000Z",
        created_at: "2026-10-26T08:00:00.000Z",
      }),
    ]);
    await sweepArrivalScans(ENV, NOW);
    expect(readSource).not.toHaveBeenCalled();
    expect(db.tables.arrival_scans[0]).toMatchObject({
      status: "failed",
      error: "gave up after 3 attempts",
    });
  });

  it("deletes buckets older than ninety days and keeps the rest", async () => {
    const old = new Date(NOW.getTime() - (BUCKET_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    seed(
      [scan({ status: "done" })],
      [
        { scan_id: "old", kind: "admin", created_at: old },
        { scan_id: "scan-1", kind: "admin", created_at: "2026-10-20T00:00:00.000Z" },
      ],
    );
    expect(await sweepArrivalScans(ENV, NOW)).toBe(false);
    expect(db.tables.arrival_buckets.map((b) => b.scan_id)).toEqual(["scan-1"]);
  });
});
