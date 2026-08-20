import { describe, it, expect } from "vitest";
import { parsePersonaSuggestion, buildPersonaMessages } from "./persona-suggest";

describe("parsePersonaSuggestion", () => {
  it("parses well-formed { persona: string } JSON", () => {
    const raw = JSON.stringify({ persona: "You are a senior growth copywriter." });
    expect(parsePersonaSuggestion(raw)).toBe("You are a senior growth copywriter.");
  });

  it("trims surrounding whitespace", () => {
    const raw = JSON.stringify({ persona: "  You are a analyst.\n\n" });
    expect(parsePersonaSuggestion(raw)).toBe("You are a analyst.");
  });

  it("returns null for a blank or non-string persona", () => {
    expect(parsePersonaSuggestion(JSON.stringify({ persona: "" }))).toBeNull();
    expect(parsePersonaSuggestion(JSON.stringify({ persona: "   " }))).toBeNull();
    expect(parsePersonaSuggestion(JSON.stringify({ persona: 42 }))).toBeNull();
  });

  it("returns null for non-JSON, non-object, or missing persona", () => {
    expect(parsePersonaSuggestion("not json")).toBeNull();
    expect(parsePersonaSuggestion("[]")).toBeNull();
    expect(parsePersonaSuggestion(JSON.stringify({}))).toBeNull();
    expect(parsePersonaSuggestion("null")).toBeNull();
  });
});

describe("buildPersonaMessages", () => {
  it("includes the agent title and asks for a JSON persona", () => {
    const msgs = buildPersonaMessages("Growth Copywriter");
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content.toLowerCase()).toContain("json");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Growth Copywriter");
  });

  it("tells the model to answer in the language of the title", () => {
    // Deliberately a non-English title (Turkish for "Content Editor"): the
    // prompt must mirror the title's language, so an English fixture could
    // not tell a working implementation from a broken one.
    const msgs = buildPersonaMessages("İçerik Editörü");
    expect(msgs[0].content.toLowerCase()).toContain("language");
  });
});
