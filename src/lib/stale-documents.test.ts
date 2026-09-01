import { describe, it, expect } from "vitest";

import { documentsWorthRevisiting, countedSince } from "./stale-documents";
import { STALE_AFTER_DAYS } from "./relative-time";

const NOW = Date.UTC(2026, 8, 1);
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

const doc = (id: string, days: number, name = id) => ({ id, name, createdAt: daysAgo(days) });

describe("documentsWorthRevisiting", () => {
  it("wants both facts, not either one", () => {
    // The pair is the whole idea. Old-and-unused is nobody's problem; used-and-
    // recent is the product working.
    const documents = [doc("old-unused", 400), doc("recent-busy", 3)];
    expect(
      documentsWorthRevisiting(documents, { "old-unused": 0, "recent-busy": 90 }, NOW),
    ).toEqual([]);
  });

  it("lists a document that is both old and leaned on", () => {
    const result = documentsWorthRevisiting([doc("onboarding", 280)], { onboarding: 41 }, NOW);
    expect(result).toEqual([
      { id: "onboarding", name: "onboarding", citations: 41, age: "9 months ago" },
    ]);
  });

  it("orders by how many answers stand on it, not by age", () => {
    // The ordering the issue asks for. Age decides whether a document is a
    // candidate; the count decides which one to fix first.
    const documents = [doc("ancient", 900), doc("merely-old", 200)];
    const result = documentsWorthRevisiting(documents, { ancient: 1, "merely-old": 60 }, NOW);
    expect(result.map((r) => r.id)).toEqual(["merely-old", "ancient"]);
  });

  it("breaks a tie by name, so the list does not shuffle between renders", () => {
    const documents = [doc("b", 200), doc("a", 300)];
    const result = documentsWorthRevisiting(documents, { a: 5, b: 5 }, NOW);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not count a document the day before it is old enough to doubt", () => {
    const documents = [
      doc("day-before", STALE_AFTER_DAYS - 1),
      doc("on-the-day", STALE_AFTER_DAYS),
    ];
    const result = documentsWorthRevisiting(documents, { "day-before": 99, "on-the-day": 1 }, NOW);
    expect(result.map((r) => r.id)).toEqual(["on-the-day"]);
  });

  it("treats a document nothing has counted as uncounted, not as zero-risk", () => {
    // A missing key and an explicit zero mean the same thing here — no answer
    // stands on it *within the window*. Neither is evidence the document is
    // fine, which is why the caption saying what the window is ships with it.
    const documents = [doc("missing", 400), doc("explicit", 400)];
    expect(documentsWorthRevisiting(documents, { explicit: 0 }, NOW)).toEqual([]);
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(documentsWorthRevisiting([], {}, NOW)).toEqual([]);
  });
});

describe("countedSince", () => {
  it("names the date the numbers start at", () => {
    expect(countedSince(Date.UTC(2026, 7, 24))).toBe("Counting answers since Aug 24, 2026.");
  });

  it("says nothing when nothing has been counted", () => {
    // Different from every document scoring zero, and the interface has to be
    // able to tell those apart: one is "no answers cite these", the other is
    // "no answer has been countable yet".
    expect(countedSince(null)).toBeNull();
  });
});
