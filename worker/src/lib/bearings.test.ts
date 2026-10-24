import { describe, expect, it } from "vitest";
import { preparePassages } from "./bearings";
import { chunkText } from "./embeddings";

describe("preparePassages", () => {
  it("keeps each chunk bare and embeds it under the document's name", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about onboarding.`).join(
      "\n\n",
    );
    const prepared = preparePassages("notes.md", text);
    const chunks = chunkText(text);

    expect(prepared).toHaveLength(chunks.length);
    prepared.forEach((p, i) => {
      expect(p.content).toBe(chunks[i]);
      expect(p.embedInput.startsWith("notes.md\n\n")).toBe(true);
    });
  });

  it("carries a table's header row into every passage it embeds, not into what it stores", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `A${i},${i * 10}`).join("\n");
    const prepared = preparePassages("prices.csv", `sku,price\n${rows}`);

    expect(prepared.length).toBeGreaterThan(1);
    expect(prepared[1].embedInput).toContain("sku,price");
    expect(prepared[1].content).not.toContain("sku,price");
  });

  it("prepares nothing from an empty document", () => {
    expect(preparePassages("x.md", "")).toEqual([]);
  });
});
