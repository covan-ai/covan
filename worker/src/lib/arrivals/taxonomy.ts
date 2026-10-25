/**
 * The ten kinds of work that arrive, the same for every customer.
 *
 * This is the commoditised part (spec: "The frame"): no sector, no department,
 * no configuration. Ten because the report has to fit on one screen and the
 * model has to be reliable at picking one. Adding a kind is a new
 * `TAXONOMY_VERSION`, a line in 0139's check, and a proposal — nothing else.
 *
 * The frontend keeps its own copy of the ids in `src/lib/arrivals.ts`, with the
 * names a person reads; `src/lib/arrivals.test.ts` holds the two lists equal.
 */

export const TAXONOMY_VERSION = 1;

export const KINDS = [
  "question",
  "request",
  "scheduling",
  "update",
  "admin",
  "people",
  "pitch",
  "automated",
  "internal",
  "other",
] as const;

export type ArrivalKind = (typeof KINDS)[number];

/** One line per kind, the spec's table, read by the classifying model. */
export const KIND_GUIDE: Record<ArrivalKind, string> = {
  question: "Somebody outside the team asks something and waits for an answer.",
  request: "Somebody needs the person to do, decide or approve something.",
  scheduling: "Finding a time, confirming, rescheduling; and the meetings themselves.",
  update: "Status, FYI, reports; nothing is asked of the person.",
  admin: "Bills, receipts, contracts, accounts, tooling.",
  people: "Job applications, interviews, references.",
  pitch: "Vendors and strangers selling something.",
  automated: "Sent by a machine (notifications, newsletters, alerts); nobody is waiting.",
  internal: "Mail among the team's own addresses.",
  other: "Anything that fits none of the above.",
};

/**
 * Where somebody is waiting on the person. A newsletter never gets a reply and
 * should not inflate "never got a reply", so only these two are counted.
 */
export const UNANSWERED_KINDS: ReadonlySet<ArrivalKind> = new Set<ArrivalKind>([
  "question",
  "request",
]);

/** The routine template proposed for a kind; kinds absent here get none. */
export const PROPOSAL_FOR: Partial<Record<ArrivalKind, string>> = {
  question: "arrivals-questions",
  request: "arrivals-requests",
  scheduling: "arrivals-day-ahead",
  update: "arrivals-updates",
  admin: "arrivals-admin",
  people: "arrivals-candidates",
};

export function isKind(x: unknown): x is ArrivalKind {
  return typeof x === "string" && (KINDS as readonly string[]).includes(x);
}
