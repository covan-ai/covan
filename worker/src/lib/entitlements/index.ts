import type { RoutineEnv } from "../../types";

/**
 * What a caller is allowed to spend.
 *
 * Covan is open-core on hosting, not on features: everything a self-hoster runs
 * is the whole product. The one thing a hosted service needs and a repository
 * does not is a way to stop one account from spending the operator's OpenAI
 * budget without limit. That — and only that — lives behind this interface.
 *
 * The open build ships `unlimitedEntitlements` below, and it is a real
 * implementation rather than a stub that throws: no licence key, no phone-home,
 * no "community edition". A metered implementation is registered by the hosted
 * build's entry point via `registerEntitlements`, and nothing else in the codebase
 * knows the difference.
 *
 * Accounting is in tokens, not messages, because tokens are what the operator
 * is actually billed for. A single turn late in a long conversation with
 * retrieved documents attached can cost fifty times what the first turn cost,
 * and a message counter would price both at one.
 */

export type QuotaVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Tokens spent in the current period. */
      used: number;
      /** Tokens allowed in the current period. */
      limit: number;
      /** ISO timestamp when the counter resets. */
      resetsAt: string;
    };

export type QuotaSnapshot = {
  used: number;
  /** `null` means unmetered — the interface's way of saying "no quota exists". */
  limit: number | null;
  resetsAt: string | null;
};

export interface Entitlements {
  /**
   * Pre-flight. Called before work that will spend tokens. Answering `allowed`
   * is a statement about the past, not a reservation: the cost of the work
   * about to be done is unknowable until it is done, so a caller can overshoot
   * its limit by one operation. That is deliberate — reserving an estimate up
   * front would either refuse work that would have fit or hold budget that is
   * never spent.
   */
  check(userId: string): Promise<QuotaVerdict>;

  /** Post-flight. Called once per operation with the tokens it actually cost. */
  record(userId: string, tokens: number): Promise<void>;

  /** For display. `limit: null` tells the UI there is nothing to show. */
  snapshot(userId: string): Promise<QuotaSnapshot>;
}

export type EntitlementsFactory = (env: RoutineEnv) => Entitlements;

/**
 * What an embedding token costs relative to a chat token.
 *
 * A counter has to be denominated in something, and this one is denominated in
 * chat tokens — because that is where the money goes. `text-embedding-3-small`
 * is $0.02 per million; `gpt-4o` is $2.50 in and $10.00 out, so a mixed chat
 * token runs around $4.00 per million. That is a factor of roughly 200, rounded
 * here to 100 in the counter's favour.
 *
 * Counting embeddings at face value would have a hundred-page upload — a tenth
 * of a cent of real spend — eat a third of a small monthly allowance, and
 * uploading documents is the one behaviour this product exists to encourage.
 * Charging it at par would price the core loop like the expensive one.
 */
export const EMBEDDING_TOKEN_WEIGHT = 0.01;

/** Embedding tokens expressed in chat tokens, for the counter. */
export function embeddingCost(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.ceil(tokens * EMBEDDING_TOKEN_WEIGHT);
}

export const unlimitedEntitlements: Entitlements = {
  async check() {
    return { allowed: true };
  },
  async record() {
    // Nothing to count.
  },
  async snapshot() {
    return { used: 0, limit: null, resetsAt: null };
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
  // silently stops counting anyone's usage. QUOTA_MONTHLY_TOKENS is only ever
  // set on the hosted build, so its presence next to an unregistered factory
  // means exactly that mistake. Logged rather than fatal: refusing to serve
  // would turn a billing leak into an outage.
  if (factory === unmeteredFactory && env.QUOTA_MONTHLY_TOKENS && !misconfigurationLogged) {
    misconfigurationLogged = true;
    console.error(
      "QUOTA_MONTHLY_TOKENS is set but no entitlements implementation is registered — " +
        "usage is NOT being metered. Check that the deployed entry point registers one.",
    );
  }
  return factory(env);
}
