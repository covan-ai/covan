import { describe, it, expect } from "vitest";
import { formatFileSize } from "./file-size";

describe("formatFileSize", () => {
  it("counts bytes below a kilobyte, because 0.4 KB tells nobody anything", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(412)).toBe("412 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("keeps one decimal only where it distinguishes two rows", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(12 * 1024)).toBe("12 KB");
  });

  // The case the helper exists for: the upload limit is 10 MB, and a 4 MB file
  // used to read "4096 KB".
  it("steps up to megabytes rather than printing four digits of kilobytes", () => {
    expect(formatFileSize(4 * 1024 * 1024)).toBe("4.0 MB");
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("says nothing rather than guessing for a size it was not given", () => {
    expect(formatFileSize(Number.NaN)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
  });
});
