import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { lexer, type Token, type Tokens } from "marked";
import { safeHref } from "./links";

/**
 * A Markdown document as a Word file.
 *
 * Covan's documents are Markdown — a report the engine wrote, a routine's
 * filed summary — and the people they are for live in Word. This walks the
 * Markdown the way `marked` reads it and builds the same structure out of
 * `docx` paragraphs: headings as Word's own heading styles (so the navigation
 * pane and a table of contents work), lists as real numbered and bulleted
 * lists, tables as tables, code in a monospace face.
 *
 * Pure JavaScript and no file system, so it runs unchanged on Workers and on
 * Node. What it does not carry: images (a generated document has none) and
 * maths, which arrives as its source text.
 */

const BODY_FONT = "Calibri";
const CODE_FONT = "Consolas";
const ORDERED = "covan-ordered";

type Run = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean; link?: boolean };

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Inline tokens as runs, carrying the formatting of everything around them. */
function inline(tokens: Token[] | undefined, style: Run = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        out.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(run((token as Tokens.Codespan).text, { ...style, code: true }));
        break;
      case "br":
        out.push(new TextRun({ break: 1 }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        if (href) {
          out.push(
            new ExternalHyperlink({
              link: href,
              children: inline(link.tokens, { ...style, link: true }),
            }),
          );
        } else {
          out.push(...inline(link.tokens, style));
        }
        break;
      }
      case "image":
        out.push(run((token as Tokens.Image).text || "", { ...style, italics: true }));
        break;
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) out.push(...inline(text.tokens, style));
        else out.push(run(decode(text.text), style));
        break;
      }
      case "escape":
        out.push(run((token as Tokens.Escape).text, style));
        break;
      default:
        // `html` and anything newer than this file: shown as the text it is,
        // never interpreted.
        if ("raw" in token && typeof token.raw === "string") out.push(run(token.raw, style));
    }
  }
  return out;
}

function run(text: string, style: Run): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    ...(style.link ? { style: "Hyperlink" } : {}),
    ...(style.code
      ? {
          font: CODE_FONT,
          shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEEDE6" },
        }
      : {}),
  });
}

/** `marked` leaves entities in plain text; Word wants the characters. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

type Block = Paragraph | Table;

type Walk = { list: number };

function blocks(tokens: Token[], walk: Walk, quoteDepth = 0): Block[] {
  const out: Block[] = [];
  const indent = quoteDepth > 0 ? { left: 360 * quoteDepth } : undefined;
  const quoteBorder =
    quoteDepth > 0
      ? { left: { style: BorderStyle.SINGLE, size: 12, color: "C9C6BA", space: 8 } }
      : undefined;

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push(
          new Paragraph({
            heading: HEADINGS[Math.min(Math.max(heading.depth, 1), 6) - 1],
            children: inline(heading.tokens),
          }),
        );
        break;
      }
      case "paragraph":
        out.push(
          new Paragraph({
            children: inline((token as Tokens.Paragraph).tokens),
            indent,
            border: quoteBorder,
          }),
        );
        break;
      case "list":
        out.push(...list(token as Tokens.List, 0, walk));
        break;
      case "table":
        out.push(table(token as Tokens.Table));
        break;
      case "code": {
        const lines = (token as Tokens.Code).text.split("\n");
        for (const line of lines) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: CODE_FONT, size: 19 })],
              shading: { type: ShadingType.CLEAR, color: "auto", fill: "F7F7F4" },
              spacing: { before: 0, after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ children: [] }));
        break;
      }
      case "blockquote":
        out.push(...blocks((token as Tokens.Blockquote).tokens, walk, quoteDepth + 1));
        break;
      case "hr":
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "C9C6BA", space: 1 } },
          }),
        );
        break;
      case "space":
        break;
      default:
        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          out.push(new Paragraph({ children: [run(token.text, {})], indent }));
        }
    }
  }
  return out;
}

function list(token: Tokens.List, level: number, walk: Walk): Paragraph[] {
  const out: Paragraph[] = [];
  // A fresh instance per ordered list, so the second list in a document starts
  // at 1 instead of carrying on from the first.
  const instance = token.ordered ? ++walk.list : 0;
  for (const item of token.items) {
    let first = true;
    for (const child of item.tokens) {
      if (child.type === "list") {
        out.push(...list(child as Tokens.List, Math.min(level + 1, 8), walk));
        continue;
      }
      const tokens =
        child.type === "text" || child.type === "paragraph"
          ? (child as Tokens.Text).tokens
          : undefined;
      const children = tokens ? inline(tokens) : inline([child]);
      if (item.task) children.unshift(run(item.checked ? "☑ " : "☐ ", {}));
      out.push(
        new Paragraph({
          children,
          ...(first
            ? token.ordered
              ? { numbering: { reference: ORDERED, level, instance } }
              : { bullet: { level } }
            : { indent: { left: 720 * (level + 1) } }),
        }),
      );
      first = false;
    }
  }
  return out;
}

function table(token: Tokens.Table): Table {
  const align = (a: Tokens.TableCell["align"]) =>
    a === "center"
      ? AlignmentType.CENTER
      : a === "right"
        ? AlignmentType.RIGHT
        : AlignmentType.LEFT;
  const cell = (c: Tokens.TableCell, header: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          alignment: align(c.align),
          children: inline(c.tokens, header ? { bold: true } : {}),
        }),
      ],
      ...(header ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEEDE6" } } : {}),
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: token.header.map((c) => cell(c, true)) }),
      ...token.rows.map((row) => new TableRow({ children: row.map((c) => cell(c, false)) })),
    ],
  });
}

/** The first `# ` heading, which is what Covan's documents are named after. */
function titleOf(tokens: Token[]): string | undefined {
  const first = tokens.find((t) => t.type === "heading") as Tokens.Heading | undefined;
  return first?.text;
}

export async function markdownToDocx(markdown: string): Promise<Uint8Array> {
  const tokens = lexer(markdown);
  const doc = new Document({
    title: titleOf(tokens),
    creator: "Covan",
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22 } },
      },
    },
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][
              level % 3
            ],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks(tokens, { list: 0 }) }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
