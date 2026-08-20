import { describe, it, expect } from "vitest";
import { parseIdeaSuggestions, buildIdeaExtractionMessages } from "./idea-suggest";

describe("parseIdeaSuggestions", () => {
  it("parses well-formed { ideas: [...] } JSON", () => {
    const raw = JSON.stringify({
      ideas: [
        { title: "Free tier", detail: "Cap at 50/mo" },
        { title: "Referral loop", detail: null },
      ],
    });
    expect(parseIdeaSuggestions(raw)).toEqual([
      { title: "Free tier", detail: "Cap at 50/mo" },
      { title: "Referral loop", detail: null },
    ]);
  });

  it("trims titles and defaults a missing/non-string detail to null", () => {
    const raw = JSON.stringify({ ideas: [{ title: "  Idea  " }, { title: "X", detail: 5 }] });
    expect(parseIdeaSuggestions(raw)).toEqual([
      { title: "Idea", detail: null },
      { title: "X", detail: null },
    ]);
  });

  it("drops entries with no usable title", () => {
    const raw = JSON.stringify({
      ideas: [{ title: "" }, { title: "   " }, { detail: "x" }, null, 3],
    });
    expect(parseIdeaSuggestions(raw)).toEqual([]);
  });

  it("returns [] for non-JSON, non-object, or missing ideas array", () => {
    expect(parseIdeaSuggestions("not json")).toEqual([]);
    expect(parseIdeaSuggestions("[]")).toEqual([]);
    expect(parseIdeaSuggestions(JSON.stringify({ ideas: "nope" }))).toEqual([]);
    expect(parseIdeaSuggestions(JSON.stringify({}))).toEqual([]);
  });
});

describe("buildIdeaExtractionMessages", () => {
  it("includes the transcript and asks for a JSON ideas array", () => {
    const msgs = buildIdeaExtractionMessages("User: build a thing\nAgent: sure");
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content.toLowerCase()).toContain("json");
    expect(msgs[1].content).toContain("build a thing");
  });
});
