// worker/src/lib/routines/executor.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { nextRunAt } from "./schedule";
import { fetchSource, UpstreamError, type FetchDeps } from "./source";
import { diffItems, type Cursor, type FeedItem } from "./feed";
import { claimItemKeys, deliver, releaseItemKeys, type DeliveryDeps } from "./delivery";
import type { Entitlements } from "../entitlements";

export const MAX_FAILURES = 5;

/**
 * Written to `routine_runs.error` when a run is skipped for quota, and matched
 * exactly on the next tick to decide whether the owner has already been told.
 * Kept free of anything variable — a reset date in here would make every run
 * look like a new one and the notice would repeat.
 */
export const QUOTA_SKIP_REASON = "skipped: the owner's monthly token quota is used up";

/**
 * The same limit for failures that are the remote's fault rather than the
 * routine's — a 429 or a 5xx. Set far higher because backoff is capped at six
 * hours past the natural next run, so reaching this many consecutive transient
 * failures means the source has been unreachable for days. That is worth
 * pausing for; three rate-limited ticks in an afternoon is not.
 */
export const MAX_TRANSIENT_FAILURES = 20;

/** Backoff never pushes a routine more than this far past its natural next run. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type RoutineRow = {
  id: string;
  agent_id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  source_kind: "rss" | "web" | "none";
  source_config: { url?: string };
  instruction: string;
  delivery_channel_id: string;
  schedule_cron: string;
  timezone: string;
  /** The slot this run was claimed for. Used as the `none` idempotency key. */
  next_run_at: string;
  cursor: Cursor | null;
  consecutive_failures: number;
};

export type SummariseInput = {
  persona: string | null;
  model: string | null;
  instruction: string;
  items: FeedItem[];
  pageText?: string;
};

export type ExecutorDeps = {
  /** Service-role client — bypasses RLS. See the scoping note below. */
  db: SupabaseClient;
  summarise: (input: SummariseInput) => Promise<{ text: string; tokens: number }>;
  fetchDeps: FetchDeps;
  deliveryDeps: DeliveryDeps;
  /** What the routine's owner may spend. Unmetered on a self-hosted install. */
  entitlements: Entitlements;
  now: () => Date;
};

/**
 * Executes one routine, end to end. Knows nothing about what triggered it —
 * the cron dispatcher calls it today, a queue consumer could tomorrow.
 *
 * SECURITY: `deps.db` is the service-role client and bypasses row level
 * security. Every id used below is read off the routine row itself, never
 * from a caller. Nothing in this file should ever take an id as an argument.
 */
export async function runRoutine(
  routine: RoutineRow,
  deps: ExecutorDeps,
): Promise<{ status: "ok" | "skipped" | "failed"; itemsNew: number }> {
  const startedAt = deps.now();
  let claimedKeys: string[] = [];
  let delivered = false;

  try {
    // Membership is checked before anything else. Removing someone from a
    // workspace cuts their RLS access instantly, but routines run under the
    // service role — without this an ex-member's routine keeps piping a
    // workspace agent's output to their personal Slack forever. Checked here
    // rather than in the member-removal handler so it holds however membership
    // ends (direct delete, workspace transfer, cascade).
    const { data: membership, error: membershipError } = await deps.db
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", routine.workspace_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();

    if (membershipError) {
      throw new Error(`workspace membership lookup failed: ${membershipError.message}`);
    }
    if (!membership) {
      const reason = "the routine's owner is no longer a member of this workspace";
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: reason,
        pause: reason,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Quota is checked here — after membership, before anything is fetched or
    // claimed. It cannot move further down: past `claimItemKeys` a skipped run
    // leaves delivery keys reserved, and `claimItemKeys` only ever returns
    // newly-inserted ones, so those items could never be delivered again. The
    // cursor is deliberately left unadvanced, so once the quota resets the run
    // picks up exactly what it would have reported.
    const verdict = await deps.entitlements.check(routine.user_id);
    if (!verdict.allowed) {
      // Read before `finish` writes this run: the question is whether the
      // PREVIOUS one was also a quota skip.
      const alreadyTold = await lastRunWasQuotaSkip(deps.db, routine.id);
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: QUOTA_SKIP_REASON,
      });
      if (!alreadyTold) {
        await announceQuotaSkip(routine, deps, verdict.resetsAt);
      }
      return { status: "skipped", itemsNew: 0 };
    }

    const result = await fetchSource(routine, routine.cursor, deps.fetchDeps);

    if (result.status === "unchanged") {
      await finish(routine, deps, startedAt, { status: "skipped", itemsNew: 0, tokens: 0 });
      return { status: "skipped", itemsNew: 0 };
    }

    let items: FeedItem[] = [];
    let pageText: string | undefined;
    let nextCursor: Cursor;
    // Every kind gets an idempotency key, not just rss. routine_deliveries'
    // unique constraint is then the backstop for a run that overruns the
    // stale-claim window or fails between delivering and recording.
    let keysToClaim: string[] = [];

    if (result.status === "items" && routine.source_kind === "rss") {
      const diff = diffItems(result.items, routine.cursor);
      items = diff.newItems;
      nextCursor = { ...diff.nextCursor, etag: result.etag };
      keysToClaim = items.map((i) => i.key);
    } else if (result.status === "content") {
      const baseline: Cursor = {
        seenKeys: routine.cursor?.seenKeys ?? [],
        lastPublishedAt: routine.cursor?.lastPublishedAt ?? null,
        etag: result.etag,
        contentHash: result.hash,
      };

      // First run is silent for source-watching routines: with no cursor there
      // is nothing to compare against, so record the hash and say nothing
      // rather than summarising the whole page at the user.
      if (routine.cursor === null) {
        await finish(routine, deps, startedAt, {
          status: "skipped",
          itemsNew: 0,
          tokens: 0,
          cursor: baseline,
        });
        return { status: "skipped", itemsNew: 0 };
      }

      pageText = result.text;
      nextCursor = baseline;
      // Hash *and* slot. The hash alone is a content identity, and nothing
      // prunes routine_deliveries, so a page that oscillates A→B→A→B would
      // report each state once and then go quiet forever — a status page
      // flipping between "operational" and "degraded" would stop telling
      // anyone. Composing with the slot still dedupes the case the backstop
      // exists for: a retry after failed bookkeeping runs against an
      // unadvanced next_run_at, so it lands in the same slot with the same key.
      keysToClaim = [`hash:${result.hash}@${routine.next_run_at}`];
    } else {
      // source_kind === "none": nothing to diff, so it always runs — including
      // the first time. The scheduled slot is its identity, so two runs that
      // claim the same slot collide instead of double-delivering.
      nextCursor = routine.cursor ?? {
        seenKeys: [],
        lastPublishedAt: null,
        etag: null,
        contentHash: null,
      };
      keysToClaim = [`slot:${routine.next_run_at}`];
    }

    const hasWork = routine.source_kind === "none" || items.length > 0 || pageText !== undefined;
    if (!hasWork) {
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Reserve before sending. A concurrent or retried run gets back fewer keys.
    claimedKeys = await claimItemKeys(deps.db, routine.id, keysToClaim);
    if (routine.source_kind === "rss") {
      items = items.filter((i) => claimedKeys.includes(i.key));
    }
    if (claimedKeys.length === 0) {
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Checked before summarising: a routine with a missing channel shouldn't
    // pay for an LLM call it can never deliver.
    //
    // SCOPING: the service role bypasses RLS, so both lookups below are scoped
    // explicitly from the routine row — the channel to its owner, the agent to
    // the routine's workspace. Matching on id alone would make any tampered row
    // a cross-tenant read.
    const { data: channel, error: channelError } = await deps.db
      .from("delivery_channels")
      .select("kind, secret_ciphertext")
      .eq("id", routine.delivery_channel_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();

    if (channelError) throw new Error(`delivery channel lookup failed: ${channelError.message}`);
    if (!channel) throw new Error("delivery channel missing");

    const { data: agent, error: agentError } = await deps.db
      .from("agents")
      .select("persona, model")
      .eq("id", routine.agent_id)
      .eq("workspace_id", routine.workspace_id)
      .maybeSingle();

    if (agentError) throw new Error(`agent lookup failed: ${agentError.message}`);

    const summary = await deps.summarise({
      persona: agent?.persona ?? null,
      model: agent?.model ?? null,
      instruction: routine.instruction,
      items,
      pageText,
    });

    await deliver(channel, { subject: routine.name, body: summary.text }, deps.deliveryDeps);
    // Past this point the message is out. Releasing the claims would let the
    // next tick re-win them and send it again — the duplicate this whole
    // claim-first ordering exists to prevent. Leaving them claimed makes the
    // retry a no-op that simply advances the cursor.
    delivered = true;

    await finish(routine, deps, startedAt, {
      status: "ok",
      itemsNew: items.length,
      tokens: summary.tokens,
      cursor: nextCursor,
      summary: summary.text,
    });
    return { status: "ok", itemsNew: items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Hand back anything reserved but *not sent*, so the next run retries it.
    // `delivered` is the whole point: once the message is out, a failure in the
    // bookkeeping that follows must not hand the keys back, or the re-claimed
    // routine sends the same summary a second time. If the release itself fails
    // those keys stay claimed and their items can never be delivered again —
    // claimItemKeys only ever returns newly-inserted keys — so that has to reach
    // routine_runs rather than vanish.
    let releaseError: string | null = null;
    if (!delivered && claimedKeys.length > 0) {
      try {
        await releaseItemKeys(deps.db, routine.id, claimedKeys);
      } catch (releaseErr) {
        releaseError = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      }
    }

    const recorded = releaseError
      ? `${message} (${claimedKeys.length} delivery claims could not be released: ${releaseError})`
      : message;

    try {
      await finish(routine, deps, startedAt, {
        status: "failed",
        itemsNew: 0,
        tokens: 0,
        error: recorded,
        transient: err instanceof UpstreamError && err.transient,
      });
    } catch {
      // Recording the failure failed too. Clear the claim on its own so the row
      // retries at its next due time instead of waiting out the stale-claim
      // window in claim_due_routines.
      try {
        const { error } = await deps.db
          .from("routines")
          .update({ claimed_at: null })
          .eq("id", routine.id);
        if (error) throw new Error(error.message);
      } catch {
        // Nothing left to try; the stale-claim reclaim is the backstop.
      }
    }

    return { status: "failed", itemsNew: 0 };
  }
}

/**
 * Writes the run row and the routine's next state. A failure backs the interval
 * off geometrically and, at MAX_FAILURES, pauses with a reason — a routine that
 * dies quietly while the UI still says "active" is the failure that destroys
 * trust in this feature.
 */
async function finish(
  routine: RoutineRow,
  deps: ExecutorDeps,
  startedAt: Date,
  outcome: {
    status: "ok" | "skipped" | "failed";
    itemsNew: number;
    tokens: number;
    cursor?: Cursor;
    error?: string;
    /** What was delivered. Absent for skipped and failed runs, which sent nothing. */
    summary?: string;
    /** The remote's fault, not the routine's — judged against the higher limit. */
    transient?: boolean;
    /** Pause the routine with this reason, independently of the failure count. */
    pause?: string;
  },
): Promise<void> {
  const finishedAt = deps.now();

  // postgrest-js resolves { data, error }; it does not throw. An unchecked
  // insert here would drop run history silently, and an unchecked update below
  // would leave claimed_at set with next_run_at and the cursor unadvanced —
  // which for a web or none routine means re-delivering the same content on
  // every tick. Both have to be loud.
  const { error: runError } = await deps.db.from("routine_runs").insert({
    routine_id: routine.id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: outcome.status,
    items_new: outcome.itemsNew,
    tokens: outcome.tokens,
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    error: outcome.error ?? null,
    summary: outcome.summary ?? null,
  });
  if (runError) throw new Error(`routine_runs insert failed: ${runError.message}`);

  // Charged to the routine's owner, not to whoever happened to trigger it — a
  // scheduled run has no caller at all. Best-effort: the run is finished and
  // delivered, and `routine_runs.tokens` above is the durable record, so a
  // counter that cannot be written must not turn a successful run into a failed
  // one that retries and pays twice.
  if (outcome.tokens > 0) {
    try {
      await deps.entitlements.record(routine.user_id, outcome.tokens);
    } catch (err) {
      console.error("failed to record routine token usage", err);
    }
  }

  const failures = outcome.status === "failed" ? routine.consecutive_failures + 1 : 0;
  const base = nextRunAt(routine.schedule_cron, routine.timezone, finishedAt);
  const naturalDelay = base.getTime() - finishedAt.getTime();
  const multiplier = failures > 0 ? 2 ** (failures - 1) : 1;
  // Geometric backoff, but never more than six hours past the natural next run —
  // otherwise a failing daily routine drifts days into the future.
  const delay = Math.min(naturalDelay * multiplier, naturalDelay + MAX_BACKOFF_MS);
  const next = new Date(finishedAt.getTime() + delay);

  const patch: Record<string, unknown> = {
    last_run_at: finishedAt.toISOString(),
    next_run_at: next.toISOString(),
    claimed_at: null,
    consecutive_failures: failures,
    updated_at: finishedAt.toISOString(),
  };
  if (outcome.cursor) patch.cursor = outcome.cursor;

  const limit = outcome.transient ? MAX_TRANSIENT_FAILURES : MAX_FAILURES;
  // Only a pause reached this way is worth telling the owner about. The
  // membership pause below is deliberate — we are cutting off an ex-member, not
  // reporting a fault to them.
  const pausedByFailures = failures >= limit;
  if (pausedByFailures) {
    patch.status = "paused";
    patch.paused_reason = outcome.error ?? "repeated failures";
  }
  if (outcome.pause) {
    patch.status = "paused";
    patch.paused_reason = outcome.pause;
  }

  const { error: updateError } = await deps.db.from("routines").update(patch).eq("id", routine.id);
  if (updateError) throw new Error(`routines update failed: ${updateError.message}`);

  if (pausedByFailures) {
    await announcePause(routine, deps, String(patch.paused_reason));
  }
}

/**
 * Tell the owner their routine stopped, through the channel it already
 * delivers to.
 *
 * A routine that dies quietly while the interface still reads "active" is the
 * failure that destroys trust in this feature: the mail stops arriving and
 * nothing anywhere says why. Best-effort by design — the pause is already
 * committed and visible on the routine's page, and a dead delivery channel is
 * itself a plausible reason for the pause, so a notice that cannot be sent must
 * not turn into a second failure.
 */
async function announcePause(
  routine: RoutineRow,
  deps: ExecutorDeps,
  reason: string,
): Promise<void> {
  await notifyOwner(routine, deps, "routine_paused", {
    subject: `Routine paused: ${routine.name}`,
    body:
      `"${routine.name}" has been paused after repeated failures, so it will not run again ` +
      `until you resume it.\n\nLast error: ${reason}\n\n` +
      `Open the routine in the app to resume it once the cause is fixed.`,
  });
}

/**
 * Tell the owner a run was skipped because their allowance is spent.
 *
 * Sent once, not once per tick. Ticks are minutes apart — five on the
 * Cloudflare trigger in wrangler.cron.toml, ROUTINE_TICK_MS on Node — so a
 * routine left waiting on a monthly allowance would otherwise mail its owner
 * thousands of times before the month turned over. `lastRunWasQuotaSkip` below
 * is what makes it once.
 */
async function announceQuotaSkip(
  routine: RoutineRow,
  deps: ExecutorDeps,
  resetsAt: string,
): Promise<void> {
  const when = new Date(resetsAt);
  const readable = Number.isNaN(when.getTime())
    ? "when your allowance resets"
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

  await notifyOwner(routine, deps, "quota_exhausted", {
    subject: `Routine waiting on your allowance: ${routine.name}`,
    body:
      `"${routine.name}" did not run: your monthly token allowance is used up.\n\n` +
      `Nothing has been lost. The routine was stopped before it read anything, so ` +
      `whatever it would have reported is still waiting, and it will run by itself ` +
      `once the allowance resets on ${readable}.\n\n` +
      `You will not get this message again for this routine until then.`,
  });
}

/**
 * Delivers a message from the engine to a routine's owner, through the channel
 * the routine already delivers to.
 *
 * Best-effort by design. Whatever prompted the message is already recorded and
 * visible on the routine's page, and a dead delivery channel is itself a
 * plausible reason for it, so a notice that cannot be sent must not turn into a
 * second failure.
 */
async function notifyOwner(
  routine: RoutineRow,
  deps: ExecutorDeps,
  kind: "routine_paused" | "quota_exhausted",
  message: { subject: string; body: string },
): Promise<void> {
  try {
    if (!(await wantsNotice(deps.db, routine.user_id, kind))) return;

    const { data: channel } = await deps.db
      .from("delivery_channels")
      .select("kind, secret_ciphertext")
      .eq("id", routine.delivery_channel_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();
    if (!channel) return;

    await deliver(channel, message, deps.deliveryDeps);
  } catch {
    // Nothing left to do; the reason is already recorded against the run.
  }
}

/**
 * Has the owner turned this notice off?
 *
 * A missing row means they never touched the setting, which is every user until
 * they do — so no row means yes. A failed read means yes as well: these notices
 * exist because a routine dying in silence is the failure that destroys trust
 * in the feature, and a database hiccup is not a reason to add to the silence.
 * The worst case of guessing yes is one message somebody did not want.
 */
async function wantsNotice(
  db: SupabaseClient,
  userId: string,
  kind: "routine_paused" | "quota_exhausted",
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("notification_preferences")
      .select("routine_paused, quota_exhausted")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return true;
    return kind === "routine_paused"
      ? data.routine_paused !== false
      : data.quota_exhausted !== false;
  } catch {
    return true;
  }
}

/**
 * Was this routine's previous run skipped for quota?
 *
 * The engine has no memory between ticks, so the run history is where it looks.
 * A failure to read is treated as "already told" — the cost of staying quiet
 * once is a missed notice; the cost of guessing the other way is a mailbox
 * filled once per tick until the allowance resets.
 */
async function lastRunWasQuotaSkip(db: SupabaseClient, routineId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("routine_runs")
      .select("status, error")
      .eq("routine_id", routineId)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return true;
    return data?.status === "skipped" && data?.error === QUOTA_SKIP_REASON;
  } catch {
    return true;
  }
}
