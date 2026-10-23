/**
 * What to tell a person when the API refuses.
 *
 * Shared by both transports — the JSON helper and the multipart upload — because
 * the same refusal reaching a person as prose down one path and as `credits_exhausted`
 * down the other is the kind of difference nobody notices until someone is
 * looking at it.
 */
import { i18n } from "@/i18n";

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
  /**
   * Which request the server says this was (`X-Request-Id`, or `requestId` in
   * a 5xx body). The error page quotes it so a report can be matched to a log
   * line; absent when the request never reached the API.
   */
  requestId?: string;
  /**
   * The server's own words, whatever language the page is in. `message` is
   * what a person is shown; this is what a bug report should quote.
   */
  detail?: string;

  constructor(status: number, message: string, requestId?: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (requestId) this.requestId = requestId;
    if (detail && detail !== message) this.detail = detail;
  }
}

/** The request id a failed response carries, from its header or its body. */
export function requestIdOf(res: Response, body?: unknown): string | undefined {
  const fromBody = (body as { requestId?: unknown } | null | undefined)?.requestId;
  return res.headers.get("X-Request-Id") ?? (typeof fromBody === "string" ? fromBody : undefined);
}

/** The `error` string a refusal's body carries, if it carries one. */
export function statedError(body: unknown): string | null {
  const shape = body as { error?: unknown } | null | undefined;
  return typeof shape?.error === "string" ? shape.error : null;
}

/**
 * What to show for a refusal.
 *
 * A handful of refusals are codes rather than sentences, and those are turned
 * into prose here so every caller reports them the same way without knowing
 * about credits or rate limits. Everything else the API says, it says in
 * English — mostly in the register of "not found" — so when the page is in
 * another language the caller's own, translated fallback is shown instead,
 * and the server's words stay on the error as `detail` for whoever is
 * debugging. In English the server's sentence is still passed through, as it
 * always was.
 *
 * Client only (it reads the page's language); the server never shows one.
 */
export function errorMessage(
  status: number,
  body: unknown,
  fallback: string,
  language: string = i18n.resolvedLanguage ?? "en",
): string {
  const stated = statedError(body);

  switch (stated) {
    case "credits_exhausted":
      if (status === 402) {
        return i18n.t("This workspace is out of credits. An admin can ask for more from Settings.");
      }
      break;
    case "rate_limited":
      return i18n.t("Too many requests. Wait a moment and try again.");
    case "not_yours":
      return i18n.t("This isn't yours to change.");
    case "save_failed":
      return i18n.t("Couldn't save. Try again.");
  }

  if (stated !== null && language !== "en") return fallback;
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
