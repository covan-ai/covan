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
