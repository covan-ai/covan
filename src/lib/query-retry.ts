import { ApiError } from "./api-error";

/** react-query's default: the first attempt plus three more. */
const MAX_ATTEMPTS = 3;

/**
 * Whether a failed query is worth attempting again.
 *
 * react-query retries everything three times, which is right for a dropped
 * connection and wrong for an answer. A 401 means there is no session, a 403
 * means this caller may not, a 404 means it is not there — none of those
 * changes because the same request is sent again a second later. Sending it
 * four times turns one wrong request into four, which is how a page with no
 * session made twenty.
 *
 * 408 and 429 are excluded from the rule rather than included in it: both are
 * the server saying "later", which is the one 4xx that means try again.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_ATTEMPTS) return false;
  if (!(error instanceof ApiError)) return true;
  if (error.status === 408 || error.status === 429) return true;
  return error.status < 400 || error.status >= 500;
}
