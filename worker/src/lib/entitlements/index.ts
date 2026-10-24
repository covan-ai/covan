import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompletionUsage } from "../completion";
import type { RoutineEnv } from "../../types";

/**
 * What a workspace is allowed to spend, and what it spent.
 *
 * Covan is open-core on hosting, not on features: everything a self-hoster runs
 * is the whole product. The one thing a hosted service needs and a repository
 * does not is a way to stop one workspace from spending the operator's money
 * without limit. That — and only that — lives behind this interface.
 *
 * The open build ships `unlimitedEntitlements` below, and it is a real
 * implementation rather than a stub that throws: no licence key, no phone-home,
 * no "community edition". A metered implementation is registered by the hosted
 * build's entry point via `registerEntitlements`, and nothing else in the
 * codebase knows the difference.
 *
 * **This file reports what was consumed; it never says what that costs.** A
 * `Spend` is a model id and its token counts, an embedding's token count, a
 * connected-app call, a browser task and the provider's own figure for it. The
 * price book that turns those into credits belongs to the hosted build. Prices
 * do not belong in a public tree, and `boundary.test.ts` fails if they come back.
 * `quote` below is the one crossing, and it goes the safe way: a caller hands
 * over a dollar figure it estimated at list price and gets back the credits the
 * hosted build would charge for it. The rate never comes across.
 *
 * Credits belong to a workspace, not a person: one pool, any member spends it,
 * an admin tops it up. Every method is keyed by the workspace the work belongs
 * to — a session's, a routine's, a connection's — which is not necessarily the
 * caller's active one.
 */

/** Why a completion happened. Lets a ledger reader tell a title from an answer. */
export type CompletionPurpose =
  | "reply"
  | "title"
  | "follow_ups"
  | "persona"
  | "brainstorm"
  | "routine_draft"
  | "routine"
  | "report"
  | "summary"
  | "coverage"
  | "slack"
  // A scanned PDF read by Claude while it was indexed (`lib/formats/read/ocr.ts`).
  | "ocr"
  // A page of a connected app's results read for a question
  // (`lib/harness/tools/read-pages.ts`).
  | "reading"
  // Retrieved passages re-ordered for a question (`lib/rerank.ts`).
  | "rerank";

export type EmbeddingPurpose = "retrieval" | "index" | "reindex" | "sync" | "report";

/** What was consumed. Reported by open code; priced by the hosted build. */
export type Spend =
  | {
      kind: "completion";
      /** The model id as sent to the provider. */
      model: string;
      promptTokens: number;
      completionTokens: number;
      /** Inside `promptTokens`. */
      cachedTokens?: number;
      /** Inside `promptTokens`. */
      cacheWriteTokens?: number;
      /** Inside `completionTokens`. */
      reasoningTokens?: number;
      /** Server-side web searches the provider ran during the call. */
      webSearches?: number;
      purpose?: CompletionPurpose;
    }
  | { kind: "embedding"; model: string; tokens: number; purpose?: EmbeddingPurpose }
  | { kind: "transcription"; model: string; audioTokens: number }
  | { kind: "composio_call"; toolSlug?: string }
  | { kind: "composio_search" }
  | {
      kind: "browser_task";
      /**
       * `browser_tasks.id`; `null` for an attempt the provider billed but this
       * deployment never recorded (a refused start — see `wasBilled`).
       */
      browserTaskId: string | null;
      /**
       * `started`: accepted, cost unknown, so the hosted build holds a
       * provisional amount. `settled`: the run ended and `costUsd` is the
       * provider's own figure, which the hosted build trues the hold up to.
       */
      stage: "started" | "settled";
      costUsd: number | null;
    };

/**
 * What to hang a ledger row on. Advisory: a turn that aborts mid-stream is
 * charged before its assistant row exists, and deleting a message must not
 * delete its charge.
 */
export type SpendRef = {
  /** The member who caused it — attribution, not the payer. */
  userId?: string;
  sessionId?: string;
  messageId?: string;
  routineRunId?: string;
  browserTaskId?: string;
  connectionId?: string;
};

export type CreditVerdict =
  | { allowed: true }
  /** `balance` is in credits, and zero or below. */
  | { allowed: false; balance: number };

export type CreditSnapshot =
  /** The open build, and any read failure: there is nothing to show. */
  | { metered: false }
  | {
      metered: true;
      /** Credits left. May be below zero by the last operation. */
      balance: number;
      /** Credits ever added. */
      granted: number;
      /** Credits ever spent. */
      spent: number;
      /**
       * A house workspace: `check` never refuses and the UI shows no balance,
       * but the deployment is still a hosted one.
       */
      unlimited: boolean;
      /** Replies ever charged — what lets the UI say "about N replies left". */
      replies: number;
      /**
       * What a workspace must hold for `check` to let something new start.
       * Above zero on purpose — a charge lands after the work it pays for —
       * so a balance between zero and this is one the screen must call spent,
       * or it offers a composer the server will refuse. Absent means zero.
       */
      floor?: number;
    };

export interface Entitlements {
  /**
   * Pre-flight. Called before work that will spend. Answering `allowed` is a
   * statement about the past, not a reservation: the cost of the work about to
   * be done is unknowable until it is done, so a caller can overshoot by one
   * operation. Concurrent callers can each overshoot by one, and that is
   * accepted — reserving an estimate up front would either refuse work that
   * would have fit or hold credits that are never spent.
   */
  check(workspaceId: string): Promise<CreditVerdict>;

  /**
   * Post-flight. One call per operation with everything it consumed, so the
   * hosted build can write it in one go.
   */
  record(workspaceId: string, spends: Spend[], ref: SpendRef): Promise<void>;

  /** For display. `metered: false` tells the UI there is nothing to show. */
  snapshot(workspaceId: string): Promise<CreditSnapshot>;

  /**
   * Mid-flight, for work that spends in steps — an agent turn that may call
   * the model two dozen times. `spent` is everything the work has consumed so
   * far and not yet recorded; it is held against the workspace under `holdId`
   * (replacing what was held before), so that other work starting or
   * continuing meanwhile sees it, and the answer is whether there is still
   * credit left to take another step with.
   *
   * `check` alone cannot bound a turn: it is asked once, before the first
   * step, and a turn that began on the last credit could then spend many times
   * the balance before `record` saw any of it — once per concurrent turn.
   *
   * Optional: an implementation with nothing to bound leaves it out, and a
   * caller treats its absence as "carry on".
   */
  hold?(workspaceId: string, holdId: string, spent: Spend[]): Promise<boolean>;

  /** The work under `holdId` has been recorded, or is over: stop holding it. */
  release?(holdId: string): Promise<void>;

  /**
   * What `usd` of provider cost is charged as, in credits, right now.
   *
   * The open tree can estimate what work cost at list price — a usage row
   * from its token counts, a model from the reference reply in
   * `lib/pricing.ts` — but it does not know what a credit is worth or what
   * the operator marks up, and `boundary.test.ts` keeps it that way. This is
   * how a screen gets a credits figure beside such an estimate without the
   * rate ever crossing into the open code: the hosted build applies its price
   * book's conversion, at the markup of this moment, and answers a number.
   *
   * An estimate, like the dollar figure it accompanies. The ledger is the
   * record of what was charged, and nothing quoted here replaces a row in it.
   *
   * Synchronous on purpose: the rate is a constant and a date, not a read, so
   * a route maps a hundred rows without a hundred awaits.
   *
   * Optional: an implementation that charges nobody has no unit to quote in,
   * and a caller leaves the credits figure out rather than inventing one.
   */
  quote?(usd: number): number;

  /**
   * Buying credits and the settings around it (A15): auto top-up, the
   * low-balance warning, the card on file, the invoices. The hosted build's,
   * through its payment provider; absent everywhere else, where the screen
   * leaves those rows out rather than offering a card nobody can charge.
   */
  billing?: Billing;
}

/** What Settings › Usage and billing shows about paying, for one workspace. */
export type BillingSettings = {
  /**
   * Buys `amount` credits when the balance drops below `below`. `available`
   * is false until the provider can charge a saved card outside a
   * subscription; the switch is then shown off and disabled ("Coming soon").
   */
  autoTopUp: { available: boolean; enabled: boolean; below: number; amount: number };
  /** Everyone is told when the balance drops below `below`. */
  lowBalance: { enabled: boolean; below: number };
  card: { brand: string; last4: string } | null;
};

export type BillingSettingsPatch = {
  autoTopUp?: { enabled?: boolean; below?: number; amount?: number };
  lowBalance?: { enabled?: boolean; below?: number };
};

export type BillingInvoice = {
  id: string;
  /** ISO timestamp of the purchase. */
  at: string;
  credits: number;
  /** As the provider printed it, "$25.00". */
  total: string | null;
  status: "paid" | "refunded" | "pending";
};

/**
 * Every method takes the caller's own client, so the hosted build's policies
 * decide who reads and who changes what — an admin, as for the ledger.
 */
export interface Billing {
  settings(db: SupabaseClient, workspaceId: string): Promise<BillingSettings>;
  updateSettings(
    db: SupabaseClient,
    workspaceId: string,
    patch: BillingSettingsPatch,
  ): Promise<BillingSettings>;
  invoices(db: SupabaseClient, workspaceId: string): Promise<BillingInvoice[]>;
  /** Where the invoice's PDF can be fetched now, or null when it is not one of theirs. */
  invoicePdfUrl(db: SupabaseClient, workspaceId: string, invoiceId: string): Promise<string | null>;
}

/** `quote` as a plain function, or null where there is none — one `if` per route. */
export function quoteOf(
  e: Pick<Entitlements, "quote"> | undefined,
): ((usd: number) => number) | null {
  const q = e?.quote;
  return q ? (usd) => q.call(e, usd) : null;
}

/** `quote` over a map of dollar figures by id, for the model prices `/me` sends. */
export function quoteEach(
  quote: (usd: number) => number,
  byId: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(Object.entries(byId).map(([id, usd]) => [id, quote(usd)]));
}

export type EntitlementsFactory = (env: RoutineEnv) => Entitlements;

function count(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * One provider call as a `Spend`. `null` when the call reported no usage at
 * all, which is a call that never reached the provider and cost nothing.
 */
export function completionSpend(
  model: string,
  usage: Partial<CompletionUsage> | null | undefined,
  purpose?: CompletionPurpose,
): Spend | null {
  if (!usage) return null;
  const prompt = count(usage.promptTokens);
  const completion = count(usage.completionTokens);
  const searches = count(usage.webSearches);
  if (prompt === 0 && completion === 0 && searches === 0) return null;
  const spend: Extract<Spend, { kind: "completion" }> = {
    kind: "completion",
    model,
    promptTokens: prompt,
    completionTokens: completion,
  };
  if (count(usage.cachedTokens)) spend.cachedTokens = count(usage.cachedTokens);
  if (count(usage.cacheWriteTokens)) spend.cacheWriteTokens = count(usage.cacheWriteTokens);
  if (count(usage.reasoningTokens)) spend.reasoningTokens = count(usage.reasoningTokens);
  if (searches) spend.webSearches = searches;
  if (purpose) spend.purpose = purpose;
  return spend;
}

/** An embedding call as a `Spend`, or `null` when it embedded nothing. */
export function embeddingSpend(
  model: string,
  tokens: number | null | undefined,
  purpose?: EmbeddingPurpose,
): Spend | null {
  const n = count(tokens);
  if (n === 0) return null;
  return purpose
    ? { kind: "embedding", model, tokens: n, purpose }
    : { kind: "embedding", model, tokens: n };
}

/** Drops the `null`s the two helpers above return, so a call site stays one line. */
export function spends(...items: Array<Spend | null | undefined | false>): Spend[] {
  return items.filter((s): s is Spend => Boolean(s));
}

export const unlimitedEntitlements: Entitlements = {
  async check() {
    return { allowed: true };
  },
  async record() {
    // Nothing to count.
  },
  async snapshot() {
    return { metered: false };
  },
};

const unmeteredFactory: EntitlementsFactory = () => unlimitedEntitlements;

let factory: EntitlementsFactory = unmeteredFactory;
let misconfigurationLogged = false;

/**
 * Registers the implementation to use. Called once, at module load, by an entry
 * point — see the hosted build's `src/cloud.ts`. Tests use it to inject a fake
 * and must call `resetEntitlements()` afterwards.
 */
export function registerEntitlements(next: EntitlementsFactory): void {
  factory = next;
  misconfigurationLogged = false;
}

export function resetEntitlements(): void {
  factory = unmeteredFactory;
  misconfigurationLogged = false;
}

export function entitlementsFor(env: RoutineEnv): Entitlements {
  // A tripwire for one specific deployment mistake. The hosted build enables
  // metering by pointing wrangler at an entry point that registers it; a deploy
  // that points at the plain entry point instead still boots, still serves, and
  // silently stops charging anyone. CREDITS_ENABLED is only ever set on the
  // hosted build, so its presence next to an unregistered factory means exactly
  // that mistake. Logged rather than fatal: refusing to serve would turn a
  // billing leak into an outage.
  if (factory === unmeteredFactory && env.CREDITS_ENABLED && !misconfigurationLogged) {
    misconfigurationLogged = true;
    console.error(
      "CREDITS_ENABLED is set but no entitlements implementation is registered — " +
        "credits are NOT being charged. Check that the deployed entry point registers one.",
    );
  }
  return factory(env);
}
