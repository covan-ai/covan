import { describe, it, expect } from "vitest";
import {
  buildSystemPrefix,
  temperatureFor,
  maxTokensFor,
  BRAINSTORM_INSTRUCTIONS,
  CONCISION_INSTRUCTIONS,
  DEFAULT_PERSONA,
  MANIFEST_NAME_LIMIT,
} from "./prompt";

describe("buildSystemPrefix", () => {
  it("uses the default persona when none is given", () => {
    const out = buildSystemPrefix({ persona: null, mode: "normal", docNames: [] });
    expect(out).toContain(DEFAULT_PERSONA);
  });

  it("does not add brainstorm instructions in normal mode", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "normal", docNames: [] });
    expect(out).toContain("You are our PM.");
    expect(out).not.toContain(BRAINSTORM_INSTRUCTIONS);
  });

  it("layers brainstorm instructions on top of the persona in brainstorm mode", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "brainstorm", docNames: [] });
    const personaAt = out.indexOf("You are our PM.");
    const brainstormAt = out.indexOf(BRAINSTORM_INSTRUCTIONS);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(brainstormAt).toBeGreaterThan(personaAt); // persona first, then layer
  });

  it("appends a document manifest when docNames are present", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["a.md", "b.md"] });
    expect(out).toContain("a.md, b.md");
    expect(out).toContain("never claim you cannot read files");
  });

  it("tells the agent excerpts only arrive when retrieval finds them", () => {
    // The prefix is byte-identical on every turn, including the ones where
    // nothing was retrieved and no excerpt block follows. Promising the
    // contents "below" on those turns named a file, attached nothing, and left
    // the model to fill the gap.
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["a.md"] });
    expect(out).toContain("whenever retrieval finds them");
    expect(out).toContain("rather than inventing what it contains");
    expect(out).not.toContain("provided below");
  });

  it("counts the tail of a long document list instead of naming all of it", () => {
    const names = Array.from({ length: MANIFEST_NAME_LIMIT + 7 }, (_, i) => `doc-${i}.md`);
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: names });
    expect(out).toContain("doc-0.md");
    expect(out).toContain(`doc-${MANIFEST_NAME_LIMIT - 1}.md`);
    expect(out).not.toContain(`doc-${MANIFEST_NAME_LIMIT}.md`);
    expect(out).toContain("and 7 more");
  });

  it("names every document while the list is short enough to be useful", () => {
    const names = Array.from({ length: MANIFEST_NAME_LIMIT }, (_, i) => `doc-${i}.md`);
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: names });
    expect(out).toContain(`doc-${MANIFEST_NAME_LIMIT - 1}.md`);
    expect(out).not.toContain("more");
  });

  it("ignores blank document names rather than listing a gap", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: ["", "  "] });
    expect(out).not.toContain("The team has shared");
  });

  it("omits the manifest when there are no documents", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: [] });
    expect(out).not.toContain("team documents");
  });

  it("asks for concision in normal mode, after the persona", () => {
    const out = buildSystemPrefix({ persona: "You are our PM.", mode: "normal", docNames: [] });
    const personaAt = out.indexOf("You are our PM.");
    const concisionAt = out.indexOf(CONCISION_INSTRUCTIONS);
    expect(concisionAt).toBeGreaterThan(personaAt); // persona reads first
  });

  it("does not ask for concision in brainstorm mode", () => {
    // Brainstorm wants 5-10 ideas plus critique, and carries its own brevity
    // line. Layering a general "be brief" on top would fight it.
    const out = buildSystemPrefix({ persona: "P", mode: "brainstorm", docNames: [] });
    expect(out).not.toContain(CONCISION_INSTRUCTIONS);
    expect(out).toContain(BRAINSTORM_INSTRUCTIONS);
  });

  it("keeps the prefix byte-identical for identical input", () => {
    // The prefix is what OpenAI's automatic prompt cache matches on. Anything
    // that varies per turn belongs outside it (chat.ts keeps the RAG block out
    // for exactly this reason), so this guards against a future addition that
    // is not a pure function of the arguments.
    const args = { persona: "P", mode: "normal" as const, docNames: ["a.md"] };
    expect(buildSystemPrefix(args)).toBe(buildSystemPrefix(args));
  });
});

describe("temperatureFor", () => {
  it("returns 0.9 for brainstorm and undefined for normal", () => {
    expect(temperatureFor("brainstorm")).toBe(0.9);
    expect(temperatureFor("normal")).toBeUndefined();
  });
});

describe("maxTokensFor", () => {
  it("caps output for both modes, giving brainstorm more room", () => {
    expect(maxTokensFor("normal")).toBe(1536);
    expect(maxTokensFor("brainstorm")).toBe(3072);
    expect(maxTokensFor("brainstorm")).toBeGreaterThan(maxTokensFor("normal"));
  });
});
