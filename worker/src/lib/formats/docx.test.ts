import { describe, expect, it } from "vitest";
// docx's own zip library, read back here to look inside what it wrote.
import JSZip from "jszip";
import { markdownToDocx } from "./docx";

async function documentXml(markdown: string): Promise<string> {
  const bytes = await markdownToDocx(markdown);
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("no word/document.xml in the package");
  return file.async("string");
}

const REPORT = `# Çeyrek raporu

## Gelir

Gelir **4,2 milyon** oldu, _beklentinin_ üstünde. Ayrıntı için [pano](https://example.com/pano).

- Birinci madde
- İkinci madde
  - İç içe

1. Bir
2. İki

| Bölge | Tutar |
| --- | ---: |
| İstanbul | 1,2M |

\`\`\`
const x = 1;
\`\`\`

<script>alert(1)</script>
`;

describe("markdownToDocx", () => {
  it("writes a Word package", async () => {
    const bytes = await markdownToDocx("# Hello");
    // Every .docx is a zip, and every zip starts "PK".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("keeps Turkish text intact", async () => {
    const xml = await documentXml(REPORT);
    expect(xml).toContain("Çeyrek raporu");
    expect(xml).toContain("İstanbul");
  });

  it("uses Word's own heading styles, so the navigation pane works", async () => {
    const xml = await documentXml(REPORT);
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
  });

  it("makes bold bold and lists lists", async () => {
    const xml = await documentXml(REPORT);
    expect(xml).toMatch(/<w:b\/>[\s\S]*?4,2 milyon/);
    expect(xml).toContain("<w:numPr>");
  });

  it("makes a table a table", async () => {
    const xml = await documentXml(REPORT);
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("1,2M");
  });

  it("keeps a safe link and shows raw HTML as text", async () => {
    const xml = await documentXml(REPORT);
    expect(xml).toContain("w:hyperlink");
    expect(xml).toContain("&lt;script&gt;");
  });

  it("drops a link it would not let anybody click", async () => {
    const xml = await documentXml("[click](javascript:alert(1))");
    expect(xml).not.toContain("w:hyperlink");
    expect(xml).toContain("click");
  });
});
