/**
 * What every source of events has to be able to do, whoever it is.
 *
 * An adapter is the only code that knows a provider exists. Composio's trigger
 * instances, a Slack app's event subscriptions, a GitHub repository's webhook,
 * a WebSub hub's lease, a Telegram bot's `setWebhook` — each is a different
 * arrangement with a different lifetime, and each is spoken to here and
 * nowhere else. Everything above this line (`lifecycle.ts` deciding when to
 * subscribe, `receive.ts` deciding whether an arrival runs anything) is the
 * same for all of them, which is what lets an event move from one adapter to
 * another without a single routine row changing meaning (see `catalog.ts`).
 *
 * Adapters do not touch the database. They are handed the row and the
 * decrypted secret, and they answer with what should be written; the writing
 * — and the encrypting — is `lifecycle.ts`'s. So the service-role exemption
 * for event subscriptions lives in two files, not in one per provider.
 */

import type { RoutineEnv } from "../../../types";
import {
  CATALOGUE,
  type EventCatalogue,
  type EventProvider,
  type EventTypeDef,
  type NormalizedEvent,
} from "./catalog";

/** The row as the engine reads it, secret still sealed. */
export type SubscriptionRow = {
  routine_id: string;
  provider: string;
  event_type: string;
  config: Record<string, unknown>;
  external_id: string | null;
  secret_ciphertext: string | null;
  state: Record<string, unknown>;
  status: SubscriptionStatus;
  status_detail: string | null;
  expires_at: string | null;
  attempts: number;
};

export type SubscriptionStatus = "pending" | "active" | "failed" | "expired" | "disabled";

/** Everything an adapter call needs, already resolved. */
export type AdapterContext = {
  env: RoutineEnv;
  /** The routine's ids, off its own row — never a caller's. */
  routine: { id: string; user_id: string; workspace_id: string };
  subscription: SubscriptionRow;
  eventType: EventTypeDef;
  /** `secret_ciphertext`, opened. Null when the row has none. */
  secret: string | null;
};

/**
 * What a subscribe or a renew hands back to be written. Every field is
 * optional, because providers differ: Composio returns an id and nothing else,
 * a Telegram bot returns no id but needs its token kept, a Drive channel
 * returns both and an expiry.
 */
export type SubscribeResult = {
  externalId?: string | null;
  /** Plaintext. `lifecycle.ts` seals it before it reaches the database. */
  secret?: string | null;
  state?: Record<string, unknown>;
  expiresAt?: Date | null;
};

/**
 * A refusal the owner can act on, as opposed to a bug.
 *
 * `message` is written on the row as `status_detail` and shown on the
 * routine's page, so it is a sentence for a person — "Gmail is no longer
 * connected", not "401 from backend.composio.dev". `expired` says the
 * connection behind the subscription lapsed: the row goes to `expired`, which
 * the sweeper leaves alone, because no number of retries will reconnect
 * somebody's Google account for them.
 *
 * Anything else an adapter throws is treated as a transient failure with a
 * generic sentence, and retried.
 */
export class EventSourceError extends Error {
  readonly expired: boolean;
  constructor(message: string, options: { expired?: boolean } = {}) {
    super(message);
    this.name = "EventSourceError";
    this.expired = options.expired ?? false;
  }
}

export interface EventAdapter {
  provider: EventProvider;
  /**
   * Whether this deployment has what the provider needs — an API key, a
   * signing secret, a public URL. An unconfigured adapter's events are not
   * offered, which is the same decision `COMPOSIO_API_KEY` makes for tools:
   * absent is a supported configuration, not a fault.
   */
  isConfigured(env: RoutineEnv): boolean;
  /** Make the arrangement. Idempotent where the provider allows it. */
  subscribe(ctx: AdapterContext): Promise<SubscribeResult>;
  /** End it. A provider that already forgot it is not an error. */
  unsubscribe(ctx: AdapterContext): Promise<void>;
  /**
   * Pause or resume without forgetting, where the provider can — a paused
   * routine should not be sent events, and on some providers each one costs.
   * An adapter that cannot pause unsubscribes here and subscribes again on
   * resume, and returns what `subscribe` would.
   */
  setEnabled(ctx: AdapterContext, enabled: boolean): Promise<SubscribeResult | void>;
  /** Extend an arrangement that lapses. Absent for the ones that never do. */
  renew?(ctx: AdapterContext): Promise<SubscribeResult>;
  /**
   * The raw delivery, as the provider sent it, made into something a model can
   * read in a paragraph. `null` means "not an event for this routine after
   * all" — the bot's own message echoing back, an edit of a message already
   * handled — and runs nothing.
   */
  normalize(raw: unknown, ctx: AdapterContext): Promise<NormalizedEvent | null>;
}

/**
 * The registry, as an object for the reason `EventCatalogue` is one: a test
 * hands in its own rather than mocking a module.
 */
export type AdapterRegistry = { adapterFor: (provider: string) => EventAdapter | undefined };

/**
 * Empty in this build, as the catalogue is. An adapter is added here in the
 * same change that adds the catalogue entries it serves.
 */
const ADAPTERS: Partial<Record<EventProvider, EventAdapter>> = {};

export const ADAPTER_REGISTRY: AdapterRegistry = {
  adapterFor: (provider) => ADAPTERS[provider as EventProvider],
};

/** Both lookups together, which is what every caller below wants. */
export type EventRegistry = AdapterRegistry & EventCatalogue;

export const EVENT_REGISTRY: EventRegistry = { ...CATALOGUE, ...ADAPTER_REGISTRY };

/**
 * Whether this deployment can listen for this event at all: an adapter exists
 * for its provider and has what it needs. The catalogue route offers only
 * these, and `lifecycle.ts` refuses the rest with a sentence.
 */
export function canListenFor(registry: EventRegistry, env: RoutineEnv, def: EventTypeDef): boolean {
  return registry.adapterFor(def.provider)?.isConfigured(env) ?? false;
}
