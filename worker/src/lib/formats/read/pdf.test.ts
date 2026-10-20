import { describe, expect, it } from "vitest";
import { tinyPdf } from "../../../test-support/tiny-pdf";
import { UnreadableFile } from "./index";
import { pdfText } from "./pdf";

describe("reading a PDF on the server", () => {
  it("reads the text layer", async () => {
    const { text, truncated } = await pdfText(tinyPdf("Twenty days of leave a year"), 10_000);
    expect(text).toContain("Twenty days of leave a year");
    expect(truncated).toBe(false);
  });

  // An answer, not an error: the caller decides whether Claude reads it.
  it("reads a page with no text layer as nothing", async () => {
    const { text } = await pdfText(tinyPdf(""), 10_000);
    expect(text.trim()).toBe("");
  });

  it("keeps to the limit, and says it cut", async () => {
    const { text, truncated } = await pdfText(tinyPdf("Twenty days of leave a year"), 6);
    expect(text).toBe("Twenty");
    expect(truncated).toBe(true);
  });

  it("leaves the caller's bytes alone", async () => {
    const bytes = tinyPdf("Kept");
    const before = bytes.byteLength;
    await pdfText(bytes, 100);
    expect(bytes.byteLength).toBe(before);
  });

  it("refuses something that is not a PDF", async () => {
    await expect(pdfText(new TextEncoder().encode("not a pdf"), 100)).rejects.toBeInstanceOf(
      UnreadableFile,
    );
  });
});
