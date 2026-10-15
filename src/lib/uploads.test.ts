import { readFileSync } from "node:fs";
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
    const result = validateUpload(file("setup.exe"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("setup.exe");
    expect(result.ok === false && result.reason).toContain("pdf, docx, pptx, xlsx");
  });

  it("refuses a file with no extension at all", () => {
    expect(validateUpload(file("Makefile")).ok).toBe(false);
  });

  it("accepts Office documents", () => {
    for (const name of ["deck.pptx", "contract.docx", "budget.xlsx", "notes.odt"]) {
      expect(validateUpload(file(name))).toEqual({ ok: true });
    }
  });

  it("refuses a file over 100 MB", () => {
    const result = validateUpload(file("huge.md", MAX_SIZE + 1));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("100 MB");
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

/**
 * The worker enforces the upload ceiling; this file only repeats it so a person
 * is told before the bytes go anywhere. Read out of both source files rather
 * than imported, for `agent-meta.test.ts`'s reason: what has to hold is that
 * the two files say the same thing, and the failure is somebody editing one.
 */
describe("MAX_SIZE and the worker's MAX_UPLOAD_BYTES", () => {
  const declared = (path: string, name: string) => {
    const m = readFileSync(path, "utf8").match(new RegExp(`export const ${name} = ([0-9 *]+);`));
    expect(m, `${name} in ${path}`).not.toBeNull();
    return m![1].split("*").reduce((product, factor) => product * Number(factor.trim()), 1);
  };

  it("are the same number", () => {
    expect(declared("src/lib/uploads.ts", "MAX_SIZE")).toBe(
      declared("worker/src/lib/extract.ts", "MAX_UPLOAD_BYTES"),
    );
  });

  it("read the value the module actually exports, so the parse cannot rot", () => {
    expect(declared("src/lib/uploads.ts", "MAX_SIZE")).toBe(MAX_SIZE);
  });
});
