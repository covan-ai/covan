/**
 * What to tell a person when the API refuses.
 *
 * Shared by both transports — the JSON helper and the multipart upload — because
 * the same refusal reaching a person as prose down one path and as `credits_exhausted`
 * down the other is the kind of difference nobody notices until someone is
 * looking at it.
 */
/**
 * A refusal that reached a server and came back with a number.
 *
 * Lives here rather than in `api-client.ts`, which it did until anything
 * needed to reason about a status without also wanting a Supabase client:
 * that module constructs one at import time from `VITE_` variables, so
 * importing the error class pulled the whole authenticated transport — and its
 * configuration — into a plain unit test. `api-client` re-exports it, so every
 * existing call site is unchanged.
 */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorMessage(status: number, body: unknown, fallback: string): string {
  const shape = body as { error?: unknown } | null | undefined;
  const stated = typeof shape?.error === "string" ? shape.error : null;

  // 402 is the one refusal with a machine-readable shape, and its `error` field
  // is a code rather than a sentence. Turned into prose here so every caller
  // reports it the same way without knowing about credits.
  if (status === 402 && stated === "credits_exhausted") {
    return "This workspace is out of credits. An admin can ask for more from Settings.";
  }

  return stated ?? fallback;
}

/**
 * Whether a failed /me means "this account has no workspace yet".
 *
 * Somebody who signed up with an invitation waiting has none until they
 * accept it (0115), and somebody who left their last one has none either.
 * /me answers both with a 404; anything else is an outage, not a state.
 */
export function isNoWorkspace(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
