import {
  askerFloor,
  dedupeQuestions,
  enforceFloorWithCoverage,
  type RawCluster,
} from "./coverage-cluster";
import { renderCoverageReport, type CoverageTotals } from "./coverage-render";

/**
 * A coverage run, end to end.
 *
 * The first `source_kind = 'workspace'` report (0074), and the shape every
 * later one follows: read the workspace's own data, decide in our code what may
 * be said about it, and spend a model call only where language is genuinely
 * needed.
 *
 * ONE MODEL CALL. Clustering needs language; nothing else here does. The report
 * is rendered by `coverage-render.ts`, so the figures cannot be invented and
 * the same gaps produce the same text every week — see that file for the
 * argument at length.
 */

export type CoverageRunInput = {
  workspaceId: string;
  /** The routine's owner. Whose admin status is re-checked, not the caller's. */
  ownerId: string;
  days: number;
};

/** What the three run-time checks in `stoppedBy` need, read once per run. */
type WorkspaceFacts = { gapReportEnabled: boolean; ownerIsAdmin: boolean; memberCount: number };

export type CoverageDeps = {
  /** Facts the three run-time checks need, read under the service role. */
  readWorkspace: (workspaceId: string, ownerId: string) => Promise<WorkspaceFacts>;
  /** `workspace_coverage` from 0053. The counts, which disclose nothing. */
  readTotals: (workspaceId: string, days: number) => Promise<CoverageTotals>;
  /** `workspace_coverage_gaps` from 0075. */
  readGaps: (
    workspaceId: string,
    days: number,
  ) => Promise<Array<{ question: string; asker_key: number }>>;
  /**
   * The one model call: distinct questions in, clusters out.
   *
   * Takes the questions as an array rather than a prompt, because WHERE they go
   * in the prompt is not this module's decision to leave open. They are
   * third-party text — somebody else typed them — so they ride in the user
   * message and never in a system one, which is the argument `summarise.ts`
   * makes at length for a watched page and which applies with more force here.
   */
  cluster: (questions: string[]) => Promise<{ raw: unknown; model: string; tokens: number }>;
};

export type CoverageRunResult =
  /** Something that will not fix itself on the next tick. */
  | { kind: "pause"; reason: string }
  /**
   * Nothing to say this week. `model` and `tokens` are unset when nothing was
   * spent finding that out — the empty-read skip and the too-few-askers skip,
   * both before `deps.cluster` is ever called. The one skip that follows the
   * model call (every cluster fell short of the floor) sets both: the call
   * was made and paid for even though there is nothing to report, and the
   * executor's quota block is keyed on tokens spent, not on `kind`. Fix round
   * 1, finding 2 — this type used to have no field to carry them in, so that
   * comment was aspirational rather than true.
   */
  | { kind: "skip"; note: string; model?: string; tokens?: number }
  | { kind: "report"; summary: string; model: string; tokens: number };

/**
 * The three conditions, re-asked on every run — and the facts, and the asker
 * floor, they were answered from. The caller needs both: `facts` so it need
 * not read the workspace a second time, and `floor` so it need not re-derive
 * from `facts.memberCount` what this function already called `askerFloor` to
 * get.
 *
 * The executor runs under the service role and bypasses RLS entirely, so
 * 0074's policy cannot catch any of these: it guards creation, and all three of
 * these are things that were true then and are not now.
 *
 * All three PAUSE rather than skip. None fixes itself on the next tick, and a
 * routine that silently skips forever is the failure that destroys trust in
 * this feature — the mail stops and nothing anywhere says why. `announcePause`
 * in the executor tells the owner through the channel the routine already
 * delivers to.
 *
 * Reads `readWorkspace` exactly once — the single subrequest this function
 * spends. `runCoverageReport` below used to read it again to get the floor;
 * the floor is derived from the same `memberCount` this already has, so the
 * fix is to hand the facts back rather than ask a second time. On the cron
 * Worker a read is a subrequest against a ceiling of fifty
 * (`lib/routines/dispatcher.ts:22,198`), and a routine that spends two where
 * one would do is a routine that fits fewer of itself into a tick.
 *
 * One flat result, not a `{reason:string;facts}|{reason:null;facts}` union —
 * fix round 1, finding on the signature. With `facts` (and now `floor`)
 * identical in shape across every branch, that union carried no information
 * a plain `reason: string | null` did not; it was two members differing only
 * in a nullable field's type, with nothing to discriminate on. `floor` stays
 * `number | null` rather than asserted non-null here: `reason === null`
 * implies `floor !== null` by this function's own control flow, but nothing
 * about the two fields' *types* says so, and that implication is the caller's
 * to check, not this function's to assert away.
 */
async function stoppedBy(
  input: CoverageRunInput,
  deps: CoverageDeps,
): Promise<{ reason: string | null; facts: WorkspaceFacts; floor: number | null }> {
  const facts = await deps.readWorkspace(input.workspaceId, input.ownerId);
  const floor = askerFloor(facts.memberCount);

  if (!facts.gapReportEnabled) {
    return {
      reason: "the coverage report is no longer on for this workspace",
      facts,
      floor,
    };
  }
  if (!facts.ownerIsAdmin) {
    return {
      reason:
        "this report reads across the workspace's conversations, and its owner is no longer an admin",
      facts,
      floor,
    };
  }
  // Review Focus 1, and not a condition 0074 can guard. A workspace that shrank
  // to two people cannot have a topic reported without identifying who asked —
  // `askerFloor` answers null — so the routine stops and says so, rather than
  // skipping every week forever.
  if (floor === null) {
    return {
      reason:
        "a workspace needs at least three people before a topic can be reported without identifying who asked",
      facts,
      floor,
    };
  }
  return { reason: null, facts, floor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the model sent back, read rather than trusted.
 *
 * A structured reply is still a reply: the shape is asked for, not guaranteed.
 * Everything unrecognisable becomes nothing, which costs a report and cannot
 * cost a disclosure — and `enforceFloor` is behind this anyway, so a cluster
 * that survives parsing still has to survive the floor.
 *
 * Fix round 1, finding 1. `completion.ts`'s `extractJsonObject` docblock
 * (:314-324) says what a reply actually is: OpenAI's `response_format:
 * {type:"json_object"}` guarantees a top-level JSON *object*, and the
 * Anthropic path extracts one too — never a bare top-level array. So the
 * shape this must read is an object wrapping the array under a `clusters`
 * key, `{"clusters": [...]}`. A bare array is still accepted — it costs one
 * line, and a caller may hand the array over already unwrapped — but it was
 * never going to be what the model's own reply looks like. The prompt that
 * names the `clusters` key is Task 13's, not this file's.
 */
export function parseClusters(raw: unknown): RawCluster[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.clusters)
      ? raw.clusters
      : null;
  if (list === null) return [];

  const clusters: RawCluster[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { label, members } = entry as { label?: unknown; members?: unknown };
    if (typeof label !== "string") continue;
    if (!Array.isArray(members)) continue;

    const usable = members.filter((m): m is number => Number.isInteger(m));
    if (usable.length === 0) continue;

    clusters.push({ label, members: usable });
  }
  return clusters;
}

export async function runCoverageReport(
  input: CoverageRunInput,
  deps: CoverageDeps,
): Promise<CoverageRunResult> {
  const stopped = await stoppedBy(input, deps);
  if (stopped.reason !== null) return { kind: "pause", reason: stopped.reason };

  if (stopped.floor === null) {
    // Unreachable by `stoppedBy`'s own control flow: a null `reason` is only
    // ever returned once `askerFloor` on the same facts has already answered
    // non-null — the branch above pauses otherwise. Thrown rather than
    // asserted away, so that if this invariant is ever broken by a future
    // change on either side, the failure is loud instead of a silently wrong
    // floor. Comment-held invariants have rotted three separate times on this
    // branch; this one checks itself instead of asking to be trusted.
    throw new Error("stoppedBy returned no pause reason but no asker floor");
  }
  const floor = stopped.floor;

  const rows = await deps.readGaps(input.workspaceId, input.days);
  if (rows.length === 0) {
    return { kind: "skip", note: "every answer in this window found something close" };
  }

  const deduped = dedupeQuestions(
    rows.map((r) => ({ question: r.question, askerKey: r.asker_key })),
  );

  // The pre-check, and the reason a quiet week is free. If the whole window has
  // fewer distinct askers than the floor, no clustering of it can produce a
  // reportable group — so there is nothing a model call could change.
  const allAskers = new Set<number>();
  for (const q of deduped) for (const k of q.askerKeys) allAskers.add(k);
  if (allAskers.size < floor) {
    return {
      kind: "skip",
      note: `${deduped.length} question(s) fell short, from too few people to report`,
    };
  }

  const answer = await deps.cluster(deduped.map((q) => q.question));
  const { gaps, coveredCount } = enforceFloorWithCoverage(
    parseClusters(answer.raw),
    deduped,
    floor,
  );

  if (gaps.length === 0) {
    // The call was made and nothing cleared the floor. A skip, not a report:
    // "here is nothing" every week is the shape that reads as broken. The
    // tokens are still reported, because they were still spent — the executor's
    // quota block is keyed on that and not on the status, deliberately. (Fix
    // round 1, finding 2: that was only ever true of this comment, not of the
    // type, until `model`/`tokens` were added to the "skip" variant above.)
    return {
      kind: "skip",
      note: `no one topic came from ${floor} or more different people`,
      model: answer.model,
      tokens: answer.tokens,
    };
  }

  const totals = await deps.readTotals(input.workspaceId, input.days);

  // Distinct deduped questions that NO surviving gap covers — not copies, and
  // not the brief's `deduped.length - Σ gaps.questions`, which subtracts a
  // count of copies from a count of distinct questions and can go negative
  // the moment a surviving cluster holds a repeated question (see Task 12's
  // report for the worked case). `coveredCount` already counts distinct
  // questions, out of the same resolution that decided `gaps`, so this
  // subtraction is unit-consistent and needs no clamp to stay non-negative:
  // `coveredCount` can never exceed `deduped.length`.
  const withheld = deduped.length - coveredCount;

  return {
    kind: "report",
    summary: renderCoverageReport({ totals, gaps, withheld }),
    model: answer.model,
    tokens: answer.tokens,
  };
}
