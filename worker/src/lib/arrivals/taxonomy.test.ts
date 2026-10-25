import { describe, expect, it } from "vitest";
import {
  KINDS,
  KIND_GUIDE,
  PROPOSAL_FOR,
  TAXONOMY_VERSION,
  UNANSWERED_KINDS,
  isKind,
} from "./taxonomy";

describe("the taxonomy", () => {
  it("is ten kinds, in the order the report lists them when counts tie", () => {
    expect(KINDS).toEqual([
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
    ]);
    expect(TAXONOMY_VERSION).toBe(1);
  });

  it("says what every kind is, for the model", () => {
    for (const kind of KINDS) expect(KIND_GUIDE[kind].length).toBeGreaterThan(10);
  });

  it("proposes a routine for six kinds, each an arrivals template", () => {
    expect(Object.keys(PROPOSAL_FOR).sort()).toEqual([
      "admin",
      "people",
      "question",
      "request",
      "scheduling",
      "update",
    ]);
    for (const id of Object.values(PROPOSAL_FOR)) expect(id).toMatch(/^arrivals-/);
  });

  it("knows its own ids and nothing else", () => {
    expect(isKind("question")).toBe(true);
    expect(isKind("spam")).toBe(false);
    expect(isKind(3)).toBe(false);
  });

  it("counts a reply as owed only where somebody is waiting", () => {
    expect([...UNANSWERED_KINDS].sort()).toEqual(["question", "request"]);
  });
});
