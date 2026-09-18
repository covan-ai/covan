import { describe, it, expect } from "vitest";
import { buildFollowUpMessages, parseFollowUps } from "./follow-ups";

describe("buildFollowUpMessages", () => {
  it("puts question and answer into the user message", () => {
    const msgs = buildFollowUpMessages("What is TypeScript?", "TypeScript is a typed superset...");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("What is TypeScript?");
    expect(msgs[1].content).toContain("TypeScript is a typed superset...");
  });

  it("caps long inputs", () => {
    const long = "x".repeat(5000);
    const msgs = buildFollowUpMessages(long, long);
    expect(msgs[1].content.length).toBeLessThan(5000);
  });

  it("asks for the same language as the question", () => {
    const msgs = buildFollowUpMessages("Merhaba", "Cevap");
    expect(msgs[0].content).toContain("same language as the question");
  });
});

describe("parseFollowUps", () => {
  it("parses a well-formed response", () => {
    const raw = '{"questions":["What else?","How does it work?","Any examples?"]}';
    expect(parseFollowUps(raw)).toEqual(["What else?", "How does it work?", "Any examples?"]);
  });

  it("returns empty for malformed JSON", () => {
    expect(parseFollowUps("not json")).toEqual([]);
  });

  it("returns empty for missing questions key", () => {
    expect(parseFollowUps('{"items":["a","b"]}')).toEqual([]);
  });

  it("filters out non-string entries", () => {
    const raw = '{"questions":["Valid",123,null,"Also valid"]}';
    expect(parseFollowUps(raw)).toEqual(["Valid", "Also valid"]);
  });

  it("filters out empty strings", () => {
    const raw = '{"questions":["Good","","  ","Fine"]}';
    expect(parseFollowUps(raw)).toEqual(["Good", "Fine"]);
  });

  it("handles a fenced JSON response", () => {
    expect(parseFollowUps('```json\n{"questions":["a"]}\n```')).toEqual([]);
  });
});
