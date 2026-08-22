import { describe, it, expect } from "vitest";
import { ALLOWED_EXT, MAX_SIZE, extOf, validateUpload } from "./uploads";

// A File stand-in: validation only ever reads these two fields, and jsdom's
// File constructor would make every case read like a blob-building exercise.
const file = (name: string, size = 1024) => ({ name, size });

describe("extOf", () => {
  it("returns the characters after the last dot, lowercased", () => {
    expect(extOf("Report.PDF")).toBe("pdf");
  });

  it("reads the last dot, not the first", () => {
    expect(extOf("q3.final.md")).toBe("md");
  });

  it("returns an empty string when there is no extension", () => {
    expect(extOf("Makefile")).toBe("");
  });
});

describe("validateUpload", () => {
  it.each(ALLOWED_EXT)("accepts a .%s file", (ext) => {
    expect(validateUpload(file(`notes.${ext}`))).toEqual({ ok: true });
  });

  it("accepts an extension typed in capitals", () => {
    expect(validateUpload(file("NOTES.MD"))).toEqual({ ok: true });
  });

  it("refuses an unsupported extension and names the file", () => {
    const result = validateUpload(file("deck.pptx"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("deck.pptx");
    expect(result.ok === false && result.reason).toContain("md, txt, csv, json, pdf");
  });

  it("refuses a file with no extension at all", () => {
    expect(validateUpload(file("Makefile")).ok).toBe(false);
  });

  it("refuses a file over 10 MB", () => {
    const result = validateUpload(file("huge.md", MAX_SIZE + 1));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("10 MB");
  });

  it("accepts a file exactly at the limit", () => {
    expect(validateUpload(file("edge.md", MAX_SIZE))).toEqual({ ok: true });
  });

  it("refuses an empty file, which would upload and index nothing", () => {
    const result = validateUpload(file("empty.md", 0));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("empty");
  });
});
