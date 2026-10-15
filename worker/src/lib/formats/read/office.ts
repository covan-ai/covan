import { decodeEntities, tidy } from "./text";
import { listZip, readZipEntry, ZipError, type RangeReader, type ZipEntry } from "./zip";

/**
 * Text out of Word, PowerPoint, Excel and OpenDocument files.
 *
 * Each is a zip of XML, and each keeps its text in a known place. These read
 * that place with regular expressions rather than an XML parser, on purpose:
 * the parts of the schema that carry text are a handful of elements, a parser
 * would build a tree of every run and property to hand back a few strings, and
 * a 40 MB `document.xml` is a tree a Worker cannot hold.
 *
 * What comes out is Markdown-ish, because the chunker and the model both read
 * structure from it: headings as `#`, list items as `- `, tables as pipe rows,
 * slides and sheets under their own headings.
 */

/** No single XML entry may inflate past this. A 400-page manual's text is a fraction of it. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

type Archive = {
  entries: Map<string, ZipEntry>;
  text(name: string): Promise<string | null>;
};

async function openArchive(read: RangeReader, size: number): Promise<Archive> {
  const entries = new Map((await listZip(read, size)).map((e) => [e.name, e]));
  const utf8 = new TextDecoder();
  return {
    entries,
    async text(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      return utf8.decode(await readZipEntry(read, entry, MAX_ENTRY_BYTES));
    },
  };
}

/** Every match of `re` in `s`, as the matched strings. */
const all = (s: string, re: RegExp) => s.match(re) ?? [];

/** The concatenated text of every `<tag ...>text</tag>` in `xml`. */
function runs(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let out = "";
  for (let m = re.exec(xml); m; m = re.exec(xml)) out += m[1];
  return decodeEntities(out);
}

const byNumber = (prefix: string) => (a: string, b: string) =>
  Number(a.slice(prefix.length).replace(/\D+/g, "")) -
  Number(b.slice(prefix.length).replace(/\D+/g, ""));

// ---- Word ----------------------------------------------------------------------

/** One `<w:p>` as a line of Markdown. */
function wordParagraph(p: string): string {
  // Tabs and breaks are elements, not text; they become what they look like.
  const withBreaks = p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>");
  const text = runs(withBreaks, "w:t").trim();
  if (!text) return "";
  const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
  const heading = /^(?:Heading|Balk|Başlık)\s*(\d)$/i.exec(style);
  if (heading) return `${"#".repeat(Math.min(6, Number(heading[1])))} ${text}`;
  if (/^Title$|^KonuBal/i.test(style)) return `# ${text}`;
  if (p.includes("<w:numPr>")) return `- ${text}`;
  return text;
}

function wordTable(table: string): string {
  const rows = all(table, /<w:tr[\s>][\s\S]*?<\/w:tr>/g).map((row) =>
    all(row, /<w:tc[\s>][\s\S]*?<\/w:tc>/g).map((cell) =>
      all(cell, /<w:p[\s>][\s\S]*?<\/w:p>/g)
        .map(wordParagraph)
        .filter(Boolean)
        .join(" ")
        .replace(/\|/g, "/"),
    ),
  );
  return rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function wordBody(xml: string): string {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: string[] = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const block = m[0];
    blocks.push(block.startsWith("<w:tbl>") ? wordTable(block) : wordParagraph(block));
  }
  return blocks.filter(Boolean).join("\n\n");
}

export async function docxText(read: RangeReader, size: number): Promise<string> {
  const zip = await openArchive(read, size);
  const document = await zip.text("word/document.xml");
  if (document === null) throw new ZipError("not a Word document (no word/document.xml)");
  const parts = [wordBody(document)];
  // Footnotes and endnotes carry real content in contracts and papers.
  for (const extra of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const xml = await zip.text(extra);
    if (xml) {
      const notes = wordBody(xml);
      if (notes) parts.push(notes);
    }
  }
  return tidy(parts.join("\n\n"));
}

// ---- PowerPoint ------------------------------------------------------------------

function slideText(xml: string): string {
  return all(xml, /<a:p>[\s\S]*?<\/a:p>/g)
    .map((p) => runs(p.replace(/<a:br\/>/g, "<a:t>\n</a:t>"), "a:t").trim())
    .filter(Boolean)
    .join("\n");
}

export async function pptxText(read: RangeReader, size: number): Promise<string> {
  const zip = await openArchive(read, size);
  const slides = [...zip.entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(byNumber("ppt/slides/slide"));
  if (slides.length === 0) throw new ZipError("not a PowerPoint deck (no slides)");

  const out: string[] = [];
  for (const [i, name] of slides.entries()) {
    const n = name.match(/(\d+)\.xml$/)![1];
    const body = slideText((await zip.text(name)) ?? "");
    // Speaker notes are where a deck keeps what the slide only gestures at.
    const notes = slideText((await zip.text(`ppt/notesSlides/notesSlide${n}.xml`)) ?? "")
      // A notes page repeats the slide number as text; it says nothing.
      .replace(/^\d+$/gm, "")
      .trim();
    const parts = [`## Slide ${i + 1}`, body];
    if (notes) parts.push(`Notes: ${notes}`);
    out.push(parts.filter(Boolean).join("\n\n"));
  }
  return tidy(out.join("\n\n"));
}

// ---- Excel -----------------------------------------------------------------------

/** "BC12" → 54 (zero-based column). */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Each sheet as CSV under its own heading, stopping at `maxChars`.
 *
 * Values are what the cell shows when it is text, and the stored number when
 * it is a number — dates arrive as serial numbers, which is a loss, but a
 * correct one: formatting them would mean reading the styles part and guessing
 * at the format codes.
 */
export async function xlsxText(read: RangeReader, size: number, maxChars: number): Promise<string> {
  const zip = await openArchive(read, size);

  const shared: string[] = [];
  const sst = await zip.text("xl/sharedStrings.xml");
  if (sst) {
    for (const si of all(sst, /<si>[\s\S]*?<\/si>/g)) shared.push(runs(si, "t"));
  }

  const workbook = (await zip.text("xl/workbook.xml")) ?? "";
  const rels = (await zip.text("xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map<string, string>();
  for (const rel of all(rels, /<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1];
    const to = /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (id && to) target.set(id, to.replace(/^\/?(xl\/)?/, "xl/"));
  }
  let sheets = all(workbook, /<sheet\b[^>]*\/?>/g).map((tag) => ({
    name: decodeEntities(/\bname="([^"]*)"/.exec(tag)?.[1] ?? "Sheet"),
    path: target.get(/\br:id="([^"]+)"/.exec(tag)?.[1] ?? "") ?? "",
  }));
  if (sheets.every((s) => !zip.entries.has(s.path))) {
    sheets = [...zip.entries.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort(byNumber("xl/worksheets/sheet"))
      .map((path, i) => ({ name: `Sheet ${i + 1}`, path }));
  }
  if (sheets.length === 0) throw new ZipError("not an Excel workbook (no sheets)");

  const out: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const xml = await zip.text(sheet.path);
    if (!xml) continue;
    const lines: string[] = [];
    for (const row of all(xml, /<row\b[^>]*>[\s\S]*?<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of all(row, /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cell)?.[1];
        const type = /\bt="([^"]+)"/.exec(cell)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
        let value = "";
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = runs(cell, "t");
        else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
        else if (raw !== undefined) value = decodeEntities(raw);
        const at = ref ? columnOf(ref) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = csvCell(value.trim());
      }
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) lines.push(cells.join(","));
    }
    if (lines.length === 0) continue;
    const block = `## Sheet: ${sheet.name}\n\n${lines.join("\n")}`;
    out.push(block);
    length += block.length;
    if (length >= maxChars) break;
  }
  return out.join("\n\n");
}

// ---- OpenDocument text --------------------------------------------------------

export async function odtText(read: RangeReader, size: number): Promise<string> {
  const zip = await openArchive(read, size);
  const content = await zip.text("content.xml");
  if (content === null) throw new ZipError("not an OpenDocument file (no content.xml)");
  const body = /<office:text[^>]*>([\s\S]*)<\/office:text>/.exec(content)?.[1] ?? content;
  const s = body
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_m, n?: string) => " ".repeat(Number(n ?? 1)))
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<text:h\b([^>]*)>([\s\S]*?)<\/text:h>/g, (_m, attrs: string, inner: string) => {
      const level = Number(/text:outline-level="(\d)"/.exec(attrs)?.[1] ?? 1);
      return `\n\n${"#".repeat(level)} ${inner.replace(/<[^>]+>/g, "")}\n\n`;
    })
    .replace(/<text:list-item\b[^>]*>/g, "\n- ")
    .replace(/<\/text:p>/g, "\n\n")
    .replace(/<\/table:table-cell>/g, " | ")
    .replace(/<\/table:table-row>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(s).replace(/\n- +\n+/g, "\n- "));
}
