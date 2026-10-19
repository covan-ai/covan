import type { RoutineEnv } from "../types";
import type { ModelProvider } from "./models";

/**
 * What a model provider meant when it refused, in the few words that decide
 * what to do next.
 *
 * WHY THIS FILE EXISTS. On 2026-10-17 the OpenAI account ran out of credit, and
 * every OpenAI call answered `429 You have no credits remaining`. Every one of
 * those reached the person as "The assistant hit an error. Please try again."
 * — or as nothing at all, after a reload — and they did try again, which could
 * not help: the account was empty, and nobody who could fill it was told. The
 * last reply before anyone noticed was the previous evening (covan-ai/covan#350).
 *
 * The distinction that matters is whose problem it is:
 *
 *   - `quota` and `auth` are the operator's. The provider will refuse every
 *     request, for everyone, until somebody with the provider's dashboard
 *     acts. Retrying is noise; telling the operator is the whole point.
 *   - `rate`, `server` and `timeout` are the provider's bad minute. The same
 *     request will probably work shortly, so "try again" is honest.
 *   - `unknown` is everything else, including errors that are not a provider's
 *     at all. Treated as transient, which is how every error was treated
 *     before this file, so an error it fails to recognise behaves as it always
 *     did rather than as something worse.
 *
 * Read by shape rather than by `instanceof`: the two SDKs have separate class
 * hierarchies, a test's mock has neither, and an error that has crossed a
 * Durable Object boundary has lost its prototype anyway. Both SDKs put the
 * HTTP status on `status`; OpenAI adds `code` and `type`, and Anthropic nests
 * its type in the body under `error.error.type`.
 */

export type ProviderFailureKind = "quota" | "auth" | "rate" | "server" | "timeout" | "unknown";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  /** Which provider refused, when the caller knows. */
  provider: ModelProvider | null;
  /** Whether asking again shortly has a reasonable chance of working. */
  retryable: boolean;
  /** HTTP status, when there was a response at all. */
  status: number | null;
  /** The provider's own words, for the operator — never shown to a person. */
  detail: string;
};

/**
 * OpenAI's codes for an account that cannot pay. `insufficient_quota` is the
 * one measured on 2026-10-17; `billing_hard_limit_reached` is the documented
 * sibling for an organisation over its own spending cap, and reads the same
 * way to the person who has to fix it.
 */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
]);

/**
 * Message fragments for the same thing where there is no code to read.
 * Anthropic signals an empty balance as a plain 400 `invalid_request_error`
 * whose message says so, so the message is all there is.
 */
const QUOTA_WORDS = [
  "credit balance is too low",
  "no credits remaining",
  "exceeded your current quota",
  "billing",
];

const AUTH_CODES = new Set(["invalid_api_key", "authentication_error", "permission_error"]);

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function classifyProviderError(
  err: unknown,
  provider: ModelProvider | null = null,
): ProviderFailure {
  const statusRaw = field(err, "status");
  const status = typeof statusRaw === "number" ? statusRaw : null;
  const body = field(err, "error");
  const code = text(field(err, "code")) || text(field(body, "code"));
  const type =
    text(field(err, "type")) ||
    text(field(body, "type")) ||
    text(field(field(body, "error"), "type"));
  const name = text(field(err, "name"));
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = message.toLowerCase();
  const detail = message.slice(0, 500);

  const failure = (kind: ProviderFailureKind): ProviderFailure => ({
    kind,
    provider,
    retryable: kind !== "quota" && kind !== "auth",
    status,
    detail,
  });

  // Before the status: OpenAI sends an empty account as a 429, the same status
  // as a rate limit, and the difference between the two is the whole reason
  // this function exists.
  if (QUOTA_CODES.has(code) || QUOTA_CODES.has(type)) return failure("quota");
  if (status !== null && QUOTA_WORDS.some((words) => lower.includes(words))) {
    return failure("quota");
  }
  if (status === 401 || status === 403 || AUTH_CODES.has(code) || AUTH_CODES.has(type)) {
    return failure("auth");
  }
  if (status === 429 || type === "rate_limit_error") return failure("rate");
  if ((status !== null && status >= 500) || type === "overloaded_error" || type === "api_error") {
    return failure("server");
  }
  if (status === 408 || name === "APIConnectionTimeoutError" || /timed? ?out/.test(lower)) {
    return failure("timeout");
  }
  return failure("unknown");
}

/**
 * Whether `err` came out of one of the two model SDKs at all.
 *
 * For callers that see errors from everywhere — the routine executor catches a
 * feed's 403 in the same block as a model's — and must not read a source's
 * permanent refusal as a model's bad minute. Both SDKs set `requestID` on every
 * API error, and name their connection failures; nothing else here does either.
 */
export function isProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = text(field(err, "name"));
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  return typeof field(err, "status") === "number" && "requestID" in err;
}

/** Whether only the operator can fix this — the two kinds worth a message to them. */
export function isOperatorProblem(failure: ProviderFailure): boolean {
  return failure.kind === "quota" || failure.kind === "auth";
}

/**
 * The sentence a person reads when the model did not answer.
 *
 * Two, because they ask for different things. "Try again" for a provider's bad
 * minute is honest; for an empty account it sends the person round a loop that
 * cannot end, so that one says the model is unavailable and that nothing they
 * do will change it. It does not promise anybody was told: on the open build
 * nobody is, unless the operator reads their logs.
 */
export function explainProviderFailure(failure: ProviderFailure): string {
  return isOperatorProblem(failure)
    ? "The model is unavailable right now: its provider is refusing every request. " +
        "Trying again won't help until that is fixed on the server."
    : "The model didn't answer this time. Please try again.";
}

/**
 * Told about every refusal only the operator can fix.
 *
 * The open build has nobody to tell: a self-hoster reads their own logs, and
 * the `console.error` every caller already writes is that. The hosted build
 * registers a mailer (see its `src/cloud.ts`). Same registry shape as
 * `registerEntitlements`, for the same reason — shared code calls one function
 * and never learns which build it is in.
 */
export type ProviderFailureObserver = (env: RoutineEnv, failure: ProviderFailure) => Promise<void>;

const ignore: ProviderFailureObserver = async () => {};
let observer: ProviderFailureObserver = ignore;

export function registerProviderFailureObserver(next: ProviderFailureObserver): void {
  observer = next;
}

export function resetProviderFailureObserver(): void {
  observer = ignore;
}

/**
 * Pass a refusal to the observer if it is one the operator has to fix.
 *
 * Never throws: it runs on paths that are already reporting a failure, and a
 * second failure while reporting the first must not replace it.
 */
export async function reportProviderFailure(
  env: RoutineEnv,
  failure: ProviderFailure,
): Promise<void> {
  if (!isOperatorProblem(failure)) return;
  try {
    await observer(env, failure);
  } catch (err) {
    console.error("could not report the provider failure", err);
  }
}
