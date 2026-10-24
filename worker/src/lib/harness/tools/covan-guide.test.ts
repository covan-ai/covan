import { describe, expect, it } from "vitest";
import type { ToolContext } from "../registry";
import { COVAN_GUIDE, GUIDE_TOPICS } from "../../covan-guide-text";
import { covanGuideTool } from "./covan-guide";

const ctx = {} as ToolContext;

describe("covan_guide", () => {
  it.each(GUIDE_TOPICS)("returns the guide for %s", async (topic) => {
    const out = await covanGuideTool.run({ topic }, ctx);
    expect(out.kind).toBe("ok");
    const content = (out as { content: string }).content;
    expect(content.trim().length).toBeGreaterThan(200);
    expect(content).toBe(COVAN_GUIDE[topic]);
  });

  it("offers exactly the topics it has a guide for", () => {
    const schema = covanGuideTool.input as {
      properties: { topic: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.topic.enum).toEqual([...GUIDE_TOPICS]);
    expect(Object.keys(COVAN_GUIDE).sort()).toEqual([...GUIDE_TOPICS].sort());
    expect(schema.required).toEqual(["topic"]);
  });

  it("falls back to the overview on a topic it does not know, or none", async () => {
    for (const args of [{ topic: "pricing" }, { topic: 3 }, {}, null]) {
      const out = await covanGuideTool.run(args, ctx);
      expect(out).toEqual({ kind: "ok", content: COVAN_GUIDE.overview });
    }
  });

  it("tells the model when to call it and how to answer", () => {
    const d = covanGuideTool.description;
    expect(d).toContain("what Covan is");
    expect(d).toContain("what they can do with it");
    expect(d).toContain("how to do something");
    expect(d).toContain("the person's language");
    expect(d).toContain("do not paste the whole guide back");
  });

  it("changes nothing and is offered everywhere", () => {
    expect(covanGuideTool.destructive).toBe(false);
    expect(covanGuideTool.isConfigured({} as never)).toBe(true);
  });

  // Prices and plans are the hosted service's and change; a guide that quoted
  // them would be wrong the day they did.
  it("quotes no prices", () => {
    for (const text of Object.values(COVAN_GUIDE)) {
      expect(text).not.toMatch(/[$€£₺]\s?\d/);
      expect(text).not.toMatch(/\d[\d,.]*\s*(free )?credits\b/i);
    }
  });

  it("names the document abilities this build has", () => {
    expect(COVAN_GUIDE.documents).toContain("edit");
    expect(COVAN_GUIDE.documents).toContain("Markdown copy");
  });
});
