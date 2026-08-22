import { describe, expect, it } from "vitest";
import { extractDocumentText, hasIndexableText } from "./extract";

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Written as codepoints rather than literals: a NUL pasted into a source file is
// invisible, and a replacement character is indistinguishable from a font
// fallback box in a diff.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("extractDocumentText", () => {
  it("decodes a text format", () => {
    expect(extractDocumentText("notes.md", bytesOf("# Title"))).toBe("# Title");
  });

  it("returns nothing for a PDF, whose text comes from the browser instead", () => {
    expect(extractDocumentText("report.pdf", bytesOf("%PDF-1.7 ..."))).toBe("");
  });
});

describe("hasIndexableText", () => {
  it("accepts ordinary prose", () => {
    expect(hasIndexableText("The deployment runbook lives here.")).toBe(true);
  });

  it("rejects an empty string — the scanned PDF case", () => {
    expect(hasIndexableText("")).toBe(false);
  });

  it("rejects whitespace only", () => {
    expect(hasIndexableText("  \n\t \r\n ")).toBe(false);
  });

  it("rejects text carrying NUL bytes — the renamed .docx case", () => {
    expect(hasIndexableText(`PK${NUL}${NUL}word/document.xml`)).toBe(false);
  });

  it("rejects text that is mostly replacement characters", () => {
    // What a compressed archive decoded as UTF-8 actually looks like.
    expect(hasIndexableText(REPLACEMENT.repeat(60) + "a".repeat(40))).toBe(false);
  });

  it("keeps text whose non-UTF-8 accents came through mangled but readable", () => {
    // A Windows-1254 Turkish .txt decoded as UTF-8: the Turkish letters land as
    // replacement characters and the rest of the sentence survives. Mangled is
    // not the same as unreadable, and refusing this would be a regression for
    // anyone whose files predate UTF-8.
    const r = REPLACEMENT;
    const line = `Da${r}${r}t${r}m plan${r} Pazartesi g${r}n${r} ekiple payla${r}${r}lacak, `;
    expect(hasIndexableText(line.repeat(3))).toBe(true);
  });
});
