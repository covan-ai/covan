import { describe, it, expect } from "vitest";
import { refersToDocuments, namesDocument } from "./doc-question";

const NAMES = ["Q3 Handbook.pdf", "onboarding.md", "notes.txt"];

describe("refersToDocuments", () => {
  it.each([
    "summarize the file",
    "What's in the document?",
    "Summarize what you know",
    "can you read the pdf I uploaded?",
    "what does the transcript say",
  ])("says yes to %s", (message) => {
    expect(refersToDocuments(message, NAMES)).toBe(true);
  });

  it.each([
    "dosyayı özetler misin",
    "yüklediğim belgede ne yazıyor",
    "bu dokümanın içinde ne var",
    "ÖZET GEÇER MİSİN",
  ])("says yes to %s", (message) => {
    expect(refersToDocuments(message, NAMES)).toBe(true);
  });

  it.each([
    "thanks!",
    "merhaba",
    "say that again in English",
    "write me a cold email to a fintech CTO",
    "who won the world cup in 2018",
  ])("says no to %s", (message) => {
    // The ones that were pulling every attached document into the prompt, and
    // hanging a row of source chips under an answer they had nothing to do
    // with.
    expect(refersToDocuments(message, NAMES)).toBe(false);
  });

  it("recognises every starter card an empty conversation offers", () => {
    // Verbatim from src/lib/chat-starters.ts. Those cards exist to produce a
    // first answer with a citation on it — the fastest path through a new
    // agent — so one of them falling outside this heuristic silently undoes
    // the feature. "Draft something for me" is deliberately absent: it asks
    // for writing, not for a document.
    const starters = [
      "What does handbook.md say?",
      "What do these documents have in common?",
      "Summarize what you know",
      "What should I know that I haven't asked about?",
    ];
    for (const starter of starters) {
      expect(refersToDocuments(starter, ["handbook.md"]), starter).toBe(true);
    }
  });

  it("says yes when the question names a file", () => {
    expect(refersToDocuments("what does onboarding.md say?", NAMES)).toBe(true);
    expect(refersToDocuments("anything about Q3 Handbook?", NAMES)).toBe(true);
  });

  it("does not fire on a name too short to be distinctive", () => {
    // "cv" or "q3" appear inside ordinary sentences; treating them as
    // filenames would put the fallback back where it started.
    expect(refersToDocuments("I have a cv of the situation", ["cv.pdf"])).toBe(false);
  });

  it("says no when there is nothing to say it about", () => {
    expect(refersToDocuments("", NAMES)).toBe(false);
    expect(refersToDocuments("   ", NAMES)).toBe(false);
  });

  it("still recognises a keyword when the agent has no documents", () => {
    // The caller checks `hasKnowledge` separately; this must not depend on it.
    expect(refersToDocuments("summarize the file", [])).toBe(true);
  });
});

describe("namesDocument", () => {
  it("matches with or without the extension", () => {
    expect(namesDocument("what does onboarding.md say", "onboarding.md")).toBe(true);
    expect(namesDocument("what does onboarding say", "onboarding.md")).toBe(true);
  });

  it("is case insensitive across the Turkish dotted I", () => {
    expect(namesDocument("İŞE ALIM notlarında ne var", "işe alım.md")).toBe(true);
  });

  it("does not match a different file", () => {
    expect(namesDocument("what does onboarding.md say", "notes.txt")).toBe(false);
  });
});
