/**
 * Telling "the platform stopped us" apart from "the network failed".
 *
 * Cloudflare allows an invocation a fixed number of subrequests — fifty on
 * Workers Free — and every database read, model call and connected-app call
 * spends one. Past that, `fetch` simply does not work for the rest of the
 * request.
 *
 * WHY THIS NEEDS A FILE OF ITS OWN. The failure is unusually well disguised,
 * and an evening was lost to it on 2026-09-24. Only the FIRST thing to hit the
 * ceiling sees the real message; everything after it sees a broken `fetch`,
 * and every SDK has its own word for that. The OpenAI client calls it
 * `Connection error.`, which reads exactly like a dropped connection — so the
 * first diagnosis was "the network blipped", the second was "it was the
 * network again", and the truth only came out when a quota read happened to be
 * the call that tipped the count over and reported the limit in its own words.
 *
 * Matching on the message rather than a code because the platform throws a
 * plain `Error` with no code on it. That is brittle by nature: a reworded
 * message stops matching, and the result is today's behaviour rather than a
 * wrong answer, which is the right way round for a heuristic to fail.
 */

/**
 * Cloudflare's own wording, lowercased for comparison.
 *
 * `subrequests` covers the outbound-call cap that this codebase actually
 * meets. The other two are here because they arrive by the same route and read
 * the same way to somebody debugging at midnight, not because they have been
 * seen.
 */
const SIGNATURES = ["too many subrequests", "too many api requests", "exceeded resource limits"];

/** Whether this error is the runtime refusing, rather than a far end failing. */
export function isRuntimeLimit(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : typeof err === "string" ? err : "";
  if (!text) return false;
  const lower = text.toLowerCase();
  return SIGNATURES.some((signature) => lower.includes(signature));
}

/**
 * What a turn carries so the route can say what happened.
 *
 * Mutable and shared on purpose. The place that learns the truth — a quota
 * read, deep inside a tool — is not the place that has to explain it, and the
 * error that reaches `routes/chat.ts` by then says `Connection error.` and
 * nothing more. One flag is enough to carry the one fact that is worth
 * carrying.
 */
export type RuntimeLimitFlag = { hit: boolean };

/** A fresh flag for one turn. */
export function runtimeLimitFlag(): RuntimeLimitFlag {
  return { hit: false };
}
