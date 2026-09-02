import { describe, expect, it } from "vitest";
import { KNOWLEDGE_TEMPLATES } from "./knowledge-templates";
import { extOf, validateUpload } from "./uploads";

/**
 * These files exist to be filled in and uploaded back, so the tests that matter
 * are the ones about that round trip: the upload gate has to accept what it
 * hands out, and a template has to be a skeleton rather than a document.
 */
describe("knowledge templates", () => {
  it("hands out files its own upload gate accepts", () => {
    for (const template of KNOWLEDGE_TEMPLATES) {
      const size = new TextEncoder().encode(template.body).length;

      expect(extOf(template.filename)).toBe("md");
      expect(validateUpload({ name: template.filename, size })).toEqual({ ok: true });
    }
  });

  it("gives every template a distinct filename, since they land in one folder", () => {
    const names = KNOWLEDGE_TEMPLATES.map((t) => t.filename);

    expect(new Set(names).size).toBe(names.length);
  });

  it("asks questions instead of answering them", () => {
    // A template that reads like a finished document gets uploaded unedited,
    // and then the agent grounds an answer in somebody else's placeholder
    // company. Every one of these has to be visibly unfinished: the bracketed
    // prompt is the signal, and there is at least one under every heading.
    for (const template of KNOWLEDGE_TEMPLATES) {
      const headings = template.body.match(/^#{1,2} .+$/gm) ?? [];
      const prompts = template.body.match(/\[[^\]]+\]/g) ?? [];

      expect(headings.length).toBeGreaterThanOrEqual(3);
      expect(prompts.length).toBeGreaterThanOrEqual(headings.length - 1);
    }
  });

  it("stays small enough to read in one sitting", () => {
    // Not an arbitrary limit: a template long enough to be a chore is a
    // template nobody fills in, which is the same outcome as not shipping one.
    for (const template of KNOWLEDGE_TEMPLATES) {
      expect(template.body.length).toBeLessThan(1600);
      expect(template.blurb.length).toBeLessThan(90);
    }
  });

  it("covers the six subjects it promises, starting with the company itself", () => {
    // The order is what somebody reads top to bottom, and the first file should
    // be the one every other answer leans on.
    expect(KNOWLEDGE_TEMPLATES.map((t) => t.filename)).toEqual([
      "company-overview.md",
      "product-notes.md",
      "faq.md",
      "how-we-work.md",
      "glossary.md",
      "meeting-notes.md",
    ]);
  });
});
