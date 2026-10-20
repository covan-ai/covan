import { describe, expect, it } from "vitest";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { extractFromBytes, UnreadableFile } from "./index";
import { decodeText, htmlToText, rtfToText } from "./text";
import { listZip, readZipEntry } from "./zip";
import { makeZip } from "../../../test-support/make-zip";

const reader = (bytes: Uint8Array) => async (offset: number, length: number) =>
  bytes.subarray(offset, offset + length);

const MAX = 1_000_000;

describe("zip", () => {
  it("lists entries and reads stored and deflated ones", async () => {
    const zip = await makeZip({ "a.txt": "stored text", "b/c.xml": "<x>deflated ".repeat(50) });
    const entries = await listZip(reader(zip), zip.length);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b/c.xml"]);
    const b = await readZipEntry(reader(zip), entries[1], MAX);
    expect(new TextDecoder().decode(b)).toBe("<x>deflated ".repeat(50));
  });

  // A few kilobytes that inflate to gigabytes is the oldest trick there is.
  it("refuses an entry that inflates past the ceiling", async () => {
    const zip = await makeZip({ "pad.txt": "", "bomb.xml": "0".repeat(200_000) });
    const [, bomb] = await listZip(reader(zip), zip.length);
    expect(bomb.compressedSize).toBeLessThan(2_000);
    await expect(readZipEntry(reader(zip), bomb, 10_000)).rejects.toThrow(/allowed size/);
  });

  it("reads only the tail and the entries it is asked for", async () => {
    // The first entry is stored, so the bulk is really there to be skipped.
    const zip = await makeZip({ "media/big.bin": "x".repeat(500_000), "small.xml": "<w>hi</w>" });
    const asked: number[] = [];
    const counting = async (offset: number, length: number) => {
      asked.push(length);
      return zip.subarray(offset, offset + length);
    };
    const entries = await listZip(counting, zip.length);
    await readZipEntry(counting, entries[1], MAX);
    expect(asked.reduce((a, b) => a + b, 0)).toBeLessThan(zip.length / 2);
  });
});

describe("docx", () => {
  it("keeps headings, lists, tables and paragraphs", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "İzin Politikası", heading: HeadingLevel.HEADING_1 }),
            new Paragraph({
              children: [
                new TextRun("Yılda yirmi gün izin & "),
                new TextRun({ text: "ücretli", bold: true }),
              ],
            }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Kıdem")] }),
                    new TableCell({ children: [new Paragraph("Gün")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("5 yıl")] }),
                    new TableCell({ children: [new Paragraph("25")] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });
    const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));

    const got = await extractFromBytes("politika.docx", bytes, MAX);

    expect(got!.text).toContain("# İzin Politikası");
    expect(got!.text).toContain("Yılda yirmi gün izin & ücretli");
    expect(got!.text).toContain("| Kıdem | Gün |");
    expect(got!.text).toContain("| 5 yıl | 25 |");
    expect(got!.truncated).toBe(false);
  });

  it("says a broken file is not what its name claims", async () => {
    await expect(
      extractFromBytes("broken.docx", new TextEncoder().encode("not a zip at all, sorry"), MAX),
    ).rejects.toBeInstanceOf(UnreadableFile);
  });
});

describe("pptx", () => {
  it("reads slides in order, with their notes", async () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const zip = await makeZip({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/slide10.xml": slide("Tenth"),
      "ppt/slides/slide2.xml": slide("Second"),
      "ppt/slides/slide1.xml": slide("First &amp; foremost"),
      "ppt/notesSlides/notesSlide2.xml": `<p:notes><a:p><a:r><a:t>Say this out loud</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>`,
    });

    const { text } = (await extractFromBytes("deck.pptx", zip, MAX))!;

    expect(text.indexOf("First & foremost")).toBeLessThan(text.indexOf("Second"));
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("Tenth"));
    expect(text).toContain("## Slide 2\n\nSecond\n\nNotes: Say this out loud");
  });
});

describe("xlsx", () => {
  it("reads every sheet as CSV under its name", async () => {
    const zip = await makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Fiyatlar" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Plan</t></si><si><t>Ücret, aylık</t></si><si><r><t>Pro</t></r><r><t> plan</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>20</v></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>inline</t></is></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
    });

    const { text } = (await extractFromBytes("book.xlsx", zip, MAX))!;

    expect(text).toContain('## Sheet: Fiyatlar\n\nPlan,"Ücret, aylık"\nPro plan,,20');
    expect(text).toContain("## Sheet: Notes\n\n,inline,TRUE");
  });
});

describe("odt", () => {
  it("reads headings, paragraphs and list items", async () => {
    const zip = await makeZip({
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": `<office:document-content><office:body><office:text><text:h text:outline-level="2">Giriş</text:h><text:p>Bir<text:s text:c="2"/>iki</text:p><text:list><text:list-item><text:p>madde</text:p></text:list-item></text:list></office:text></office:body></office:document-content>`,
    });

    const { text } = (await extractFromBytes("not.odt", zip, MAX))!;

    expect(text).toContain("## Giriş");
    expect(text).toContain("Bir  iki");
    expect(text).toContain("- madde");
  });
});

describe("plain text and markup", () => {
  // The two files a Turkish office most often has that UTF-8 got wrong.
  it("reads a Windows-1254 file as Turkish, not as replacement marks", () => {
    const bytes = new Uint8Array([
      0x49, 0x7a, 0x69, 0x6e, 0x20, 0xfd, 0xf0, 0xfe, 0x20, 0xdd, 0xd0, 0xde, 0x20, 0xe7, 0xf6,
      0xfc,
    ]);
    expect(decodeText(bytes)).toBe("Izin ığş İĞŞ çöü");
  });

  it("reads UTF-16, with and without a byte-order mark", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x31, 0x01]);
    expect(decodeText(le)).toBe("Aı");
    const bare = new Uint8Array(
      [...new TextEncoder().encode("name,price\n")].flatMap((b) => [b, 0]),
    );
    expect(decodeText(bare)).toBe("name,price\n");
  });

  it("strips a UTF-8 byte-order mark", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
  });

  it("keeps the readable part of a page and its headings", () => {
    const html = `<html><head><title>Kılavuz</title><style>p{}</style></head><body><script>evil()</script><h2>Kurulum</h2><p>Adım&nbsp;1 &amp; 2</p><ul><li>bir</li><li>iki</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("# Kılavuz");
    expect(text).toContain("## Kurulum");
    expect(text).toContain("Adım 1 & 2");
    expect(text).toContain("- bir");
    expect(text).not.toContain("evil");
  });

  it("reads an RTF document's text", () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1254{\fonttbl{\f0 Calibri;}}{\colortbl;\red0\green0\blue0;}\f0 Merhaba d\'fcnya\par Ba\u351?ka \{bir\} sat\'fdr\par}`;
    expect(rtfToText(rtf)).toBe("Merhaba dünya\nBaşka {bir} satır");
  });

  it("reads only as much of a long text file as it keeps", async () => {
    const long = new TextEncoder().encode("a".repeat(5_000));
    const got = await extractFromBytes("log.txt", long, 1_000);
    expect(got).toEqual({ text: "a".repeat(1_000), truncated: true });
  });

  it("leaves a PDF to the text its upload kept", async () => {
    expect(await extractFromBytes("scan.pdf", new Uint8Array([0x25, 0x50]), MAX)).toBeNull();
  });
});
