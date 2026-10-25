import { msg } from "@/i18n";

/**
 * What arrived in somebody's mailbox and calendar, as the report shows it.
 *
 * The ids are the worker's (`worker/src/lib/arrivals/taxonomy.ts`), copied
 * rather than imported because the two trees build separately; `arrivals.test.ts`
 * holds the copies equal. The names are here because only the frontend says
 * them. React-free, like `routine-templates.ts`.
 */

export const ARRIVAL_KINDS = [
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

export type ArrivalKind = (typeof ARRIVAL_KINDS)[number];

/** Keys (`msg`): drawn with `lookup(t, …)`. */
export const KIND_NAME: Record<ArrivalKind, string> = {
  question: msg("Questions to you"),
  request: msg("Requests and approvals"),
  scheduling: msg("Meetings and scheduling"),
  update: msg("Updates for you"),
  admin: msg("Invoices, payments and admin"),
  people: msg("Candidates and hiring"),
  pitch: msg("Pitches and cold outreach"),
  automated: msg("Notifications and newsletters"),
  internal: msg("Team threads"),
  other: msg("Other"),
};

/** The routine template proposed for a kind; kinds absent here get none. */
export const PROPOSAL_FOR: Partial<Record<ArrivalKind, string>> = {
  question: "arrivals-questions",
  request: "arrivals-requests",
  scheduling: "arrivals-day-ahead",
  update: "arrivals-updates",
  admin: "arrivals-admin",
  people: "arrivals-candidates",
};

/** The only kinds whose "never got a reply" share the report shows. */
export const UNANSWERED_KINDS: ReadonlySet<ArrivalKind> = new Set<ArrivalKind>(["question", "request"]);

/** The toolkits a scan can read. A connection to any of these offers one. */
export const SCAN_TOOLKITS = ["gmail", "outlook", "googlecalendar"] as const;
export type ScanToolkit = (typeof SCAN_TOOLKITS)[number];

export type ArrivalBucket = {
  kind: ArrivalKind;
  /** The model's name for this person's version of the kind; "" means use the kind's name. */
  label: string;
  count: number;
  unanswered: number;
  /** Subjects, at most three. */
  examples: string[];
  templateId: string | null;
  routineId: string | null;
};

export type ArrivalScan = {
  id: string;
  workspaceId: string;
  userId: string;
  status: "queued" | "running" | "done" | "failed";
  taxonomy: number;
  sources: { connectionId: string; toolkit: string }[];
  windowDays: number;
  total: number | null;
  unanswered: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Sorted by count, largest first; empty until the scan is done. */
  buckets: ArrivalBucket[];
};
