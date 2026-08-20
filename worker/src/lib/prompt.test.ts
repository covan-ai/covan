import { describe, it, expect } from "vitest";
import {
  buildSystemPrefix,
  temperatureFor,
  maxTokensFor,
  BRAINSTORM_INSTRUCTIONS,
  DEFAULT_PERSONA,
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

  it("omits the manifest when there are no documents", () => {
    const out = buildSystemPrefix({ persona: "P", mode: "normal", docNames: [] });
    expect(out).not.toContain("team documents");
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
