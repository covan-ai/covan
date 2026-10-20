import { describe, expect, it } from "vitest";
import { ALLOWED_EXT, contentTypeFor, decodeFileText, hasIndexableText } from "./extract";

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Written as codepoints rather than literals: a NUL pasted into a source file is
// invisible, and a replacement character is indistinguishable from a font
// fallback box in a diff.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("decodeFileText", () => {
  it("decodes a text format", () => {
    expect(decodeFileText(bytesOf("# Title"))).toBe("# Title");
  });
});

describe("what an upload may be", () => {
  it("takes Office, OpenDocument, RTF and HTML files", () => {
    for (const ext of ["docx", "pptx", "xlsx", "odt", "rtf", "html", "tsv", "pdf", "md"]) {
      expect(ALLOWED_EXT.has(ext)).toBe(true);
    }
  });

  // Office 97-2003, which the Drives of the teams piloting Covan are full of.
  it("takes the old Office formats, served as what they are", () => {
    expect(contentTypeFor("Teklif.doc")).toBe("application/msword");
    expect(contentTypeFor("Bütçe.XLS")).toBe("application/vnd.ms-excel");
    expect(contentTypeFor("Sunum.ppt")).toBe("application/vnd.ms-powerpoint");
  });

  // Served as itself, an HTML or XML upload would be a page on this origin the
  // moment the preview framed it.
  it("serves markup as plain text", () => {
    expect(contentTypeFor("page.html")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("feed.xml")).toBe("text/plain; charset=utf-8");
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
