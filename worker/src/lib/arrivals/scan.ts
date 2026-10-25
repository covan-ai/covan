import type { RoutineEnv } from "../../types";
import { entitlementsFor, type Spend } from "../entitlements";
import { serviceClient } from "../supabase";
import { bucketise, classifyItems, headline, labelBuckets } from "./classify";
import { ArrivalReadError, readSource, type ArrivalItem, type ScanToolkit } from "./read";
import type { ArrivalKind } from "./taxonomy";

/**
 * One scan, from the claim to the counts (spec: "Where it runs").
 *
 * `POST /arrivals` queues the row through the caller's own client and starts
 * this with `deferred()`, so the person is not left waiting for a tick; the
 * tick only picks up what that start did not finish (`sweepArrivalScans`). A
 * scan fits in one invocation — a handful of Composio calls, two or three
 * model calls, a few writes — and a retry starts from zero, because nothing
 * read is kept between attempts. That is the price of the anti-goal, and at
 * these caps it is cheap.
 *
 * Service role, because there is no caller by the time this runs; see this
 * file's entry in `service-client.static.test.ts`.
 */

export const SCAN_LEASE_MS = 10 * 60_000;
export const SCAN_MAX_ATTEMPTS = 3;
export const BUCKET_RETENTION_DAYS = 90;
/** A queued scan nobody started within this long is the tick's. */
const UNSTARTED_MS = 2 * 60_000;
/** Scans the sweep runs in one tick. Each is a dozen subrequests or so. */
const SWEEP_RUNS = 2;
/**
 * What a scan may cost at most, in provider dollars, held before it starts
 * where the deployment holds credit (`reserve?`). Measured: see 0139's header.
 */
export const SCAN_CEILING_USD = 0.05;

export const NO_CREDIT =
  "This workspace has no credits left for a scan. A workspace admin can add more, and then it can be run again.";
const NO_SOURCE =
  "None of the connections this scan was asked to read is still yours and connected.";

type ScanRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  status: string;
  sources: unknown;
  attempts: number;
  lease_until: string | null;
  started_at: string | null;
};

type Source = { connection_id: string; toolkit: ScanToolkit };

function sourcesOf(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    if (typeof s !== "object" || s === null) return [];
    const { connection_id, toolkit } = s as Record<string, unknown>;
    if (typeof connection_id !== "string") return [];
    if (toolkit !== "gmail" && toolkit !== "outlook" && toolkit !== "googlecalendar") return [];
    return [{ connection_id, toolkit }];
  });
}

/** Subjects per kind, newest first and without repeats, for the label call. */
function subjectsByKind(items: ArrivalItem[], kinds: ArrivalKind[]): Map<ArrivalKind, string[]> {
  const order = items
    .map((item, i) => ({ item, kind: kinds[i] }))
    .sort((a, b) => b.item.at.localeCompare(a.item.at));
  const out = new Map<ArrivalKind, string[]>();
  for (const { item, kind } of order) {
    const subject = item.subject.trim();
    if (!subject) continue;
    const list = out.get(kind) ?? [];
    if (!list.includes(subject)) list.push(subject);
    out.set(kind, list);
  }
  return out;
}

export async function runArrivalScan(
  env: RoutineEnv,
  scanId: string,
  now = new Date(),
): Promise<void> {
  const db = serviceClient(env);
  const at = now.toISOString();

  // The claim: read, then update on the attempt count it read, so two callers
  // racing for the same row cannot both win it.
  const { data: found } = await db
    .from("arrival_scans")
    .select("id, workspace_id, user_id, status, sources, attempts, lease_until, started_at")
    .eq("id", scanId)
    .maybeSingle();
  const seen = found as ScanRow | null;
  if (!seen || (seen.status !== "queued" && seen.status !== "running")) return;
  if (seen.lease_until && seen.lease_until >= at) return;

  const attempts = seen.attempts + 1;
  const { data: claimed } = await db
    .from("arrival_scans")
    .update({
      status: "running",
      attempts,
      lease_until: new Date(now.getTime() + SCAN_LEASE_MS).toISOString(),
      started_at: seen.started_at ?? at,
    })
    .eq("id", scanId)
    .eq("attempts", seen.attempts)
    .in("status", ["queued", "running"])
    .select("id, workspace_id, user_id, sources")
    .maybeSingle();
  const scan = claimed as Pick<ScanRow, "id" | "workspace_id" | "user_id" | "sources"> | null;
  if (!scan) return;

  const finish = (values: Record<string, unknown>) =>
    db.from("arrival_scans").update(values).eq("id", scanId).eq("attempts", attempts);
  const fail = (error: string) =>
    finish({ status: "failed", error, lease_until: null, finished_at: new Date().toISOString() });

  const entitlements = entitlementsFor(env);
  const verdict = await entitlements.check(scan.workspace_id);
  if (!verdict.allowed) {
    await fail(NO_CREDIT);
    return;
  }

  const holdId = `arrivals:${scanId}`;
  const spent: Spend[] = [];
  const calls: string[] = [];
  try {
    await entitlements.reserve?.(scan.workspace_id, holdId, SCAN_CEILING_USD);

    // Only the scan owner's own, active connections in the scan's workspace:
    // the row's sources are what the caller's insert wrote, and this is where
    // they are held to whose they are.
    const sources = sourcesOf(scan.sources);
    const { data: rows } = sources.length
      ? await db
          .from("tool_connections")
          .select("id, toolkit_slug, connected_account_id, composio_user_id")
          .in(
            "id",
            sources.map((s) => s.connection_id),
          )
          .eq("workspace_id", scan.workspace_id)
          .eq("created_by", scan.user_id)
          .eq("status", "active")
          .eq("transport", "composio")
      : { data: [] };
    const connections = ((rows ?? []) as Record<string, unknown>[]).flatMap((row) => {
      const source = sources.find(
        (s) => s.connection_id === row.id && s.toolkit === row.toolkit_slug,
      );
      const composioUserId = typeof row.composio_user_id === "string" ? row.composio_user_id : "";
      if (!source || !composioUserId) return [];
      return [
        {
          connectionId: source.connection_id,
          toolkit: source.toolkit,
          account: {
            connectedAccountId:
              typeof row.connected_account_id === "string" ? row.connected_account_id : "",
            composioUserId,
          },
        },
      ];
    });
    if (connections.length === 0) {
      await fail(NO_SOURCE);
      return;
    }

    const items: ArrivalItem[] = [];
    const selfDomains: string[] = [];
    for (const source of connections) {
      try {
        const read = await readSource(env, source, now);
        calls.push(...read.calls);
        items.push(...read.items);
        selfDomains.push(...read.selfDomains);
      } catch (err) {
        if (err instanceof ArrivalReadError) calls.push(...err.calls);
        throw err;
      }
    }

    const classified = await classifyItems(env, items, { selfDomains: [...new Set(selfDomains)] });
    spent.push(...classified.spent);
    let buckets = bucketise(items, classified.kinds, now);
    if (buckets.length > 0) {
      const labelled = await labelBuckets(env, buckets, subjectsByKind(items, classified.kinds));
      spent.push(...labelled.spent);
      buckets = labelled.buckets;
    }
    const { total, unanswered } = headline(buckets);

    await db.from("arrival_buckets").delete().eq("scan_id", scanId);
    if (buckets.length > 0) {
      const { error } = await db.from("arrival_buckets").insert(
        buckets.map((b) => ({
          scan_id: scanId,
          kind: b.kind,
          label: b.label,
          count: b.count,
          unanswered: b.unanswered,
          examples: b.examples,
          template_id: b.templateId,
        })),
      );
      if (error) throw new Error(`arrivals: could not write the buckets: ${error.message}`);
    }
    await finish({
      status: "done",
      total,
      unanswered,
      error: null,
      lease_until: null,
      finished_at: at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const passing = !(err instanceof ArrivalReadError) || err.status >= 500;
    if (passing && attempts < SCAN_MAX_ATTEMPTS) {
      // The lease stays: the tick tries again once it runs out.
      console.error("arrivals: a scan attempt failed, the tick will retry", err);
    } else {
      await fail(message.slice(0, 500));
    }
  } finally {
    const all = [
      ...spent,
      ...calls.map((toolSlug): Spend => ({ kind: "composio_call", toolSlug })),
    ];
    if (all.length > 0) {
      await entitlements
        .record(scan.workspace_id, all, { userId: scan.user_id })
        .catch((err) => console.error("arrivals: could not record the scan's spend", err));
    }
    await entitlements.release?.(holdId).catch(() => {});
  }
}

/**
 * The tick's half: scans a start never finished (a lease that ran out, a
 * queued row nobody picked up), scans out of attempts, and buckets past their
 * ninety days. Answers whether it ran or failed a scan, which is what makes
 * the tick stop there.
 */
export async function sweepArrivalScans(env: RoutineEnv, now = new Date()): Promise<boolean> {
  const db = serviceClient(env);
  const at = now.toISOString();
  const unstarted = new Date(now.getTime() - UNSTARTED_MS).toISOString();

  // One read for both kinds of stalled scan: every unfinished row older than
  // a start could still be working on, then the live leases left out here.
  const { data } = await db
    .from("arrival_scans")
    .select("id, status, attempts, lease_until")
    .in("status", ["queued", "running"])
    .lt("created_at", unstarted)
    .order("created_at", { ascending: true })
    .limit(10);
  const stalled = (
    (data ?? []) as Array<{
      id: string;
      status: string;
      attempts: number;
      lease_until: string | null;
    }>
  ).filter((scan) => scan.status === "queued" || !scan.lease_until || scan.lease_until < at);

  let acted = false;
  let runs = 0;
  for (const scan of stalled) {
    if (scan.attempts >= SCAN_MAX_ATTEMPTS) {
      await db
        .from("arrival_scans")
        .update({
          status: "failed",
          error: `gave up after ${SCAN_MAX_ATTEMPTS} attempts`,
          lease_until: null,
          finished_at: at,
        })
        .eq("id", scan.id)
        .eq("attempts", scan.attempts);
      acted = true;
    } else if (runs < SWEEP_RUNS) {
      runs += 1;
      await runArrivalScan(env, scan.id, now);
      acted = true;
    }
  }

  const cutoff = new Date(now.getTime() - BUCKET_RETENTION_DAYS * 86_400_000).toISOString();
  await db.from("arrival_buckets").delete().lt("created_at", cutoff);
  return acted;
}
