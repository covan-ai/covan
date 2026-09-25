import { describe, it, expect } from "vitest";
import { CASES } from "./cases";
import { TOOLS } from "../src/lib/harness/registry";
import { DEFAULT_TOOLS } from "./stubs";
import { buildMessages } from "./harness";
import { MAX_STEPS } from "../src/lib/harness/budget";

/**
 * The eval's own tripwires. No model call, so this runs in CI with everything
 * else — `ci.yml` says "No test makes a model call" and that stays true.
 *
 * Every check here is for a mistake that is silent at run time. A case whose
 * `toolResults` key is misspelled does not fail; it replays nothing, the model
 * is told the tool found nothing, and the case quietly measures the wrong
 * thing — at full price, in a run somebody is waiting on.
 */
describe("the eval case set", () => {
  const toolNames = new Set(TOOLS.map((t) => t.name));

  it("has a case set to look at", () => {
    // The same self-check the `*.static.test.ts` files in `src/` open with: a
    // suite that silently found nothing to assert about passes forever.
    expect(CASES.length).toBeGreaterThanOrEqual(15);
  });

  it("gives every case a unique id", () => {
    // Ids name the trace file and the frozen reference. Two cases sharing one
    // would have the second overwrite the first's answer on disk, and the
    // pairwise judge would then compare a case against another case's answer.
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only names tools that exist", () => {
    const named = CASES.flatMap((c) => [
      ...Object.keys(c.toolResults),
      ...Object.keys(c.exhausted ?? {}),
      ...(c.tools ?? []),
      ...DEFAULT_TOOLS,
    ]);
    const unknown = [...new Set(named)].filter((n) => !toolNames.has(n));
    expect(unknown).toEqual([]);
  });

  it("never replays a tool the case does not offer", () => {
    // A canned result for a tool that is not in the list is dead fixture, and
    // it reads as though the case covers something it cannot: the model is
    // never given that tool, so the entry can never be reached.
    for (const c of CASES) {
      const offered = new Set(c.tools ?? DEFAULT_TOOLS);
      for (const name of Object.keys(c.toolResults)) {
        expect(offered.has(name), `${c.id} cans ${name} but does not offer it`).toBe(true);
      }
    }
  });

  it("gives every case a rubric the judge can actually check", () => {
    // A rubric is what the pairwise judge is handed in place of a gold answer.
    // An empty one does not fail the run — it produces a judge picking on
    // taste, which is the failure mode a rubric exists to prevent.
    for (const c of CASES) {
      expect(c.rubric.length, `${c.id} has no rubric`).toBeGreaterThanOrEqual(3);
      for (const line of c.rubric) expect(line.trim().length).toBeGreaterThan(20);
    }
  });

  it("tags every case, starting with the tool family", () => {
    // `tags[0]` groups the report, and the grouping is the cut that says which
    // lever a regression belongs to.
    const families = new Set([...toolNames, "no-tool", "budget"]);
    for (const c of CASES) {
      expect(c.tags.length, `${c.id} is untagged`).toBeGreaterThanOrEqual(2);
      expect(families.has(c.tags[0]), `${c.id} leads with "${c.tags[0]}"`).toBe(true);
    }
  });

  it("keeps a case's declared step count inside the budget", () => {
    // A case whose real shape needed more steps than the loop allows is not a
    // hard case, it is an unrunnable one — it would measure the budget every
    // time and never the thing it was written for.
    for (const c of CASES) expect(c.realSteps, c.id).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("covers both tool families, the no-tool case and the exhausted budget", () => {
    // The set exists to catch a regression in any of the levers Phase 4 will
    // pull. A set that drifted to all-retrieval would still pass every other
    // check here and would stop being able to see half of them.
    const leads = new Set(CASES.map((c) => c.tags[0]));
    for (const family of ["search_documents", "query_database", "no-tool", "budget"]) {
      expect(leads.has(family), `nothing covers ${family}`).toBe(true);
    }
  });

  it("includes cases where the right answer is to call nothing", () => {
    // Every lever that makes the model cheaper also makes it lazier or more
    // eager, and a set of only tool-using cases can measure one direction.
    const restrained = CASES.filter((c) => c.realSteps === 0);
    expect(restrained.length).toBeGreaterThanOrEqual(3);
    for (const c of restrained) expect(Object.keys(c.toolResults)).toEqual([]);
  });

  it("builds a prompt in the order chat.ts builds one", () => {
    // Persona, prior turns, retrieved block, question — the order is what makes
    // the prefix cacheable, and cacheability is the whole subject of the work
    // this eval guards. A case with history and a RAG block exercises all four
    // positions at once.
    const withBoth = CASES.find((c) => c.ragBlock && c.history.length > 0);
    const withRag = withBoth ?? CASES.find((c) => c.ragBlock);
    expect(withRag, "no case carries a retrieved block").toBeTruthy();

    const messages = buildMessages(withRag!);
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: withRag!.question,
    });
    // The retrieved block is the last system message and sits immediately
    // before the question, never folded into the persona.
    const ragIndex = messages.findIndex((m, i) => i > 0 && m.role === "system");
    expect(ragIndex).toBe(messages.length - 2);
  });

  it("carries enough spoiled answers to test the judge with", () => {
    // `calibrate.ts` runs on exactly the cases that have one, so an empty set
    // here is a calibration run that passes by measuring nothing — which is
    // the failure mode the "has a case set to look at" check above exists for,
    // one level down.
    const spoiled = CASES.filter((c) => c.spoiled);
    expect(spoiled.length).toBeGreaterThanOrEqual(5);
    // Spread across the families, or the calibration proves the judge can
    // separate document answers and says nothing about database ones.
    expect(new Set(spoiled.map((c) => c.tags[0])).size).toBeGreaterThanOrEqual(3);
    for (const c of spoiled) {
      expect(
        c.spoiled!.trim().length,
        `${c.id} spoiled answer is too short to judge`,
      ).toBeGreaterThan(80);
    }
  });

  it("names every document the manifest will list", () => {
    // `buildSystemPrefix` renders `docNames` into the prompt, so an empty list
    // is a different prompt — cheaper, and not the one production sends.
    for (const c of CASES) expect(c.docNames.length, c.id).toBeGreaterThan(0);
  });
});
