import { describe, it, expect, vi } from "vitest";
import { runCoverageReport, parseClusters } from "./coverage-source";

/** A workspace that is ready: on, four members, the owner an admin. */
function depsFor(
  options: {
    enabled?: boolean;
    isAdmin?: boolean;
    memberCount?: number;
    gaps?: Array<{ question: string; asker_key: number }>;
    clusters?: unknown;
  } = {},
) {
  const cluster = vi.fn().mockResolvedValue({
    raw: options.clusters ?? [{ label: "Expenses", members: [0, 1, 2] }],
    model: "gpt-4.1-mini",
    tokens: 900,
  });

  return {
    cluster,
    readWorkspace: vi.fn().mockResolvedValue({
      gapReportEnabled: options.enabled ?? true,
      ownerIsAdmin: options.isAdmin ?? true,
      memberCount: options.memberCount ?? 4,
    }),
    readTotals: vi.fn().mockResolvedValue({
      days: 7,
      answers: 100,
      covered: 97,
      fallback: 3,
      ungrounded: 0,
      unrecorded: 0,
    }),
    readGaps: vi.fn().mockResolvedValue(
      options.gaps ?? [
        { question: "how do I expense a flight", asker_key: 1 },
        { question: "who approves expenses", asker_key: 2 },
        { question: "when are expenses paid", asker_key: 3 },
      ],
    ),
  };
}

const input = { workspaceId: "w1", ownerId: "u1", days: 7 };

describe("the three conditions that stop the routine", () => {
  it("pauses when the workspace turned the report off", async () => {
    const deps = depsFor({ enabled: false });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "pause" });
    expect(result).toHaveProperty("reason", expect.stringMatching(/turned off|no longer on/i));
    expect(deps.cluster).not.toHaveBeenCalled();
  });

  it("pauses when the owner is no longer an admin", async () => {
    const deps = depsFor({ isAdmin: false });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "pause" });
    expect(deps.cluster).not.toHaveBeenCalled();
  });

  /**
   * Review Focus 1, and the condition the spec did not name. A three-person
   * workspace becomes two: the floor is now unreachable, so every run would
   * skip forever and nothing would ever say why. A pause is the honest answer —
   * the condition will not fix itself on the next tick.
   */
  it("pauses when the workspace shrank below the floor", async () => {
    const deps = depsFor({ memberCount: 2 });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "pause" });
    expect(result).toHaveProperty("reason", expect.stringMatching(/people|members/i));
    expect(deps.cluster).not.toHaveBeenCalled();
  });
});

describe("what costs nothing", () => {
  it("skips a window with no sub-floor answers, before any model call", async () => {
    const deps = depsFor({ gaps: [] });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "skip" });
    expect(deps.cluster).not.toHaveBeenCalled();
  });

  it("skips without a model call when too few people asked at all", async () => {
    const deps = depsFor({
      gaps: [
        { question: "a", asker_key: 1 },
        { question: "b", asker_key: 1 },
      ],
    });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "skip" });
    expect(deps.cluster).not.toHaveBeenCalled();
  });

  it("makes exactly one model call when it does report", async () => {
    const deps = depsFor();
    const result = await runCoverageReport(input, deps);
    expect(result.kind).toBe("report");
    expect(deps.cluster).toHaveBeenCalledTimes(1);
  });

  it("dedupes before the call, so the prompt is the distinct questions", async () => {
    const deps = depsFor({
      gaps: [
        { question: "how do I expense a flight", asker_key: 1 },
        { question: "How do I expense a flight", asker_key: 2 },
        { question: "how do i expense a flight", asker_key: 3 },
        { question: "who approves expenses", asker_key: 1 },
      ],
    });
    await runCoverageReport(input, deps);
    const questions = deps.cluster.mock.calls[0][0] as string[];
    expect(questions).toHaveLength(2);
  });

  /**
   * Step 5. `stoppedBy` reads the workspace to answer the three pause
   * conditions; the floor it derives needs nothing more than the
   * `memberCount` already in hand. A second `readWorkspace` call for the
   * floor alone would be a second subrequest spent on a fact already read —
   * see `lib/routines/dispatcher.ts:22,198` for the ceiling that makes a
   * spare read on the cron Worker not merely wasteful but load-bearing.
   */
  it("reads the workspace once", async () => {
    const deps = depsFor();
    await runCoverageReport(input, deps);
    expect(deps.readWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("the report", () => {
  it("renders the surviving clusters and names no model as the author", async () => {
    const result = await runCoverageReport(input, depsFor());
    expect(result).toMatchObject({ kind: "report", model: "gpt-4.1-mini" });
    if (result.kind === "report") {
      expect(result.summary).toContain("Expenses");
      expect(result.summary).toContain("3 people");
    }
  });

  it("skips rather than reporting nothing when every cluster fell short", async () => {
    const deps = depsFor({ clusters: [{ label: "Expenses", members: [0] }] });
    const result = await runCoverageReport(input, deps);
    expect(result).toMatchObject({ kind: "skip" });
  });

  /**
   * Requirement 4 of the task-12 brief's ruling. The brief's own suite never
   * builds this case: its only duplicate-bearing cluster (this file's
   * default `depsFor()`) is also the only cluster, covering every deduped
   * question — `withheld` is `0` there whichever formula computes it, which
   * is exactly why the defect was invisible in that suite.
   *
   * Here, ten distinct questions go in. Three of them — all about one
   * topic — were asked five times apiece (fifteen copies total) and survive
   * as one reported cluster. The other seven are each asked once, by seven
   * more people, and the model's answer does not mention them: nothing
   * clustered them, so they fall short.
   *
   * `Σ gaps.questions` for the surviving cluster is 15 — more than
   * `deduped.length` (10) on its own — so the brief's
   * `deduped.length - gaps.reduce(...)` computes `10 - 15 = -5`, clamped by
   * its own `Math.max(…, 0)` to `0`. The true count of distinct questions
   * with no surviving gap is 7 (the ten minus the three the cluster
   * covers), which is what `enforceFloorWithCoverage`'s `coveredCount`
   * yields: `10 - 3 = 7`. The assertion below is on the rendered sentence
   * itself, which only prints at all when `withheld > 0` — so a reversion to
   * the brief's formula does not merely print the wrong number here, it
   * prints no sentence, and this test fails loudly rather than off by one.
   */
  it("withholds a distinct count, not a copy count, when a surviving cluster has duplicates", async () => {
    const dupedTopics = ["topic alpha", "topic beta", "topic gamma"];
    const askerKeysPerCopy = [1, 2, 3, 4, 5];

    const dupedRows = dupedTopics.flatMap((question) =>
      askerKeysPerCopy.map((asker_key) => ({ question, asker_key })),
    );
    const scatteredRows = Array.from({ length: 7 }, (_, i) => ({
      question: `unrelated question number ${i}`,
      asker_key: 100 + i,
    }));

    const deps = depsFor({
      gaps: [...dupedRows, ...scatteredRows],
      clusters: [{ label: "Widgets", members: [0, 1, 2] }],
    });

    const result = await runCoverageReport(input, deps);

    expect(result.kind).toBe("report");
    if (result.kind !== "report") return;

    // The surviving cluster's own count is a sum of copies (15), not the
    // distinct-question count this test is about — asserted so a future
    // change to `Gap.questions`'s meaning does not make this test's premise
    // silently stop holding.
    expect(result.summary).toContain("Widgets — 15 questions, 5 people");
    // The number this test exists for: 7, not 0 and not 10.
    expect(result.summary).toContain(
      "7 other questions fell short too, but came from too few people to report.",
    );
  });
});

describe("what the model sent back is parsed, not trusted", () => {
  it("reads the shape it asked for", () => {
    expect(parseClusters([{ label: "A", members: [0, 1] }])).toEqual([
      { label: "A", members: [0, 1] },
    ]);
  });

  it("answers nothing for anything else", () => {
    for (const junk of [null, undefined, 42, "clusters", {}, [1, 2], [{ label: 5 }]]) {
      expect(parseClusters(junk), String(junk)).toEqual([]);
    }
  });

  it("drops a member list that is not integers", () => {
    expect(parseClusters([{ label: "A", members: ["0", null, 1.5, 2] }])).toEqual([
      { label: "A", members: [2] },
    ]);
  });

  it("drops a cluster with no usable members at all", () => {
    expect(parseClusters([{ label: "A", members: [] }])).toEqual([]);
  });
});
