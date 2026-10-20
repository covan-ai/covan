import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CASES } from "./cases";
import { EvalSourceError, REPO_ROOT, checkCases, insideRepo, loadCases } from "./source";

/**
 * Where an eval's cases come from, and where what it writes about them goes.
 *
 * The rule under test is one sentence: cases made of real data, and anything
 * a run writes about them, never land in this repository.
 */
const outside = mkdtempSync(join(tmpdir(), "covan-eval-"));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

describe("the public cases", () => {
  it("are the default, and write where they always have", async () => {
    const source = await loadCases({});
    expect(source.cases).toBe(CASES);
    expect(source.external).toBe(false);
    expect(source.out).toBe(join(REPO_ROOT, ".claude", "hillclimb", "agent-turn"));
  });

  it("refuse an output directory of their own, which only private cases need", async () => {
    await expect(loadCases({ EVAL_OUT: outside })).rejects.toThrow(EvalSourceError);
  });
});

describe("private cases", () => {
  const file = join(outside, "cases.mjs");
  writeFileSync(file, `export const CASES = [{ id: "pilot-1" }, { id: "pilot-2" }];\n`);

  it("are read from outside the repository, and write beside themselves", async () => {
    const source = await loadCases({ EVAL_CASES: file });
    expect(source.external).toBe(true);
    expect(source.cases.map((c) => c.id)).toEqual(["pilot-1", "pilot-2"]);
    expect(source.out).toBe(join(outside, ".results", "agent-turn"));
    expect(insideRepo(source.out)).toBe(false);
  });

  it("are refused from inside the repository", async () => {
    await expect(
      loadCases({ EVAL_CASES: join(REPO_ROOT, "worker", "eval", "cases.ts") }),
    ).rejects.toThrow(/inside this repository/);
  });

  it("refuse to write their results inside the repository", async () => {
    await expect(
      loadCases({ EVAL_CASES: file, EVAL_OUT: join(REPO_ROOT, ".claude", "hillclimb") }),
    ).rejects.toThrow(/EVAL_OUT points inside this repository/);
  });

  it("say so when the file is not there", async () => {
    await expect(loadCases({ EVAL_CASES: join(outside, "missing.ts") })).rejects.toThrow(/no file/);
  });
});

describe("checking a case list", () => {
  it("wants a non-empty list of unique ids", () => {
    expect(() => checkCases([], "x")).toThrow(/non-empty/);
    expect(() => checkCases([{ id: "a" }, { id: "a" }], "x")).toThrow(/appears twice/);
    expect(() => checkCases([{}], "x")).toThrow(/needs an id/);
  });
});

describe("telling inside from outside", () => {
  it("counts the root itself and anything under it, and nothing beside it", () => {
    expect(insideRepo(REPO_ROOT)).toBe(true);
    expect(insideRepo(join(REPO_ROOT, "worker"))).toBe(true);
    expect(insideRepo(join(REPO_ROOT, "..", "elsewhere"))).toBe(false);
    expect(insideRepo(outside)).toBe(false);
  });
});
