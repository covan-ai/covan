/**
 * A source that answered, but not with content.
 *
 * `transient` is the distinction the executor's pause logic turns on. A 404 or
 * a 403 is a statement about the routine — the feed moved, or we are not
 * allowed to read it — and no amount of retrying changes that. A 429 or a 5xx
 * is a statement about the remote's current mood: Reddit rate-limits
 * datacenter IPs hard enough to fail a healthy routine several ticks in a row,
 * and pausing for that would take a working routine offline until someone
 * noticed and resumed it by hand.
 *
 * It lives in a module of its own rather than in `source.ts` because two
 * different places now raise it — the fetch that reads a source, and the
 * delivery that writes to a receiver — and `instanceof` in `executor.ts` has to
 * see one class, not two. A file that only needs to say "the remote is having a
 * bad minute" should not have to import the feed parser and the URL guard to
 * say it.
 */
export class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`upstream ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }

  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
