import { describe, it, expect } from "vitest";
import { reportTitle, reportFileName, REPORT_TITLE_MAX_CHARS } from "./report";

describe("reportTitle", () => {
  it("takes the first heading as the title", () => {
    expect(reportTitle("# Quarterly Review\n\nSome body text.")).toBe("Quarterly Review");
  });

  it("skips anything the model wrote before the heading", () => {
    // Models open with "Here is the report you asked for:" however plainly the
    // prompt asks them to start with the title.
    expect(reportTitle("Here is your report:\n\n# Quarterly Review\n\nBody.")).toBe(
      "Quarterly Review",
    );
  });

  it("accepts a deeper heading level", () => {
    // The instruction asks for `#`, and a model that answers with `##` has
    // still named the report. Falling back to a dated filename over one extra
    // hash would throw away a title we were handed.
    expect(reportTitle("## Sprint Summary\n\nBody.")).toBe("Sprint Summary");
  });

  it("returns null when nothing in the output is a heading", () => {
    expect(reportTitle("No heading here.\nJust prose.")).toBeNull();
  });

  it("returns null for a heading with no text after the hashes", () => {
    expect(reportTitle("#   \n\nBody.")).toBeNull();
  });

  it("collapses runs of whitespace inside the title", () => {
    expect(reportTitle("#   Quarterly    Review  \n")).toBe("Quarterly Review");
  });

  it("caps a title long enough to make an unusable filename", () => {
    const title = reportTitle(`# ${"a".repeat(400)}`);
    expect(title).not.toBeNull();
    expect((title as string).length).toBe(REPORT_TITLE_MAX_CHARS);
  });
});

describe("reportFileName", () => {
  it("names the file after the title", () => {
    expect(reportFileName("Quarterly Review", "2026-09-15")).toBe("Quarterly Review.md");
  });

  it("keeps non-ASCII letters in the name", () => {
    // `documents.name` is what a person reads in the Knowledge tab. Only the R2
    // key is sanitised, the same split the upload route already makes — so a
    // Turkish title must survive this function intact.
    expect(reportFileName("Aylık Satış Raporu", "2026-09-15")).toBe("Aylık Satış Raporu.md");
  });

  it("falls back to a dated name when the model named nothing", () => {
    expect(reportFileName(null, "2026-09-15")).toBe("Report 2026-09-15.md");
  });
});
