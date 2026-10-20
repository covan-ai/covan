import { describe, expect, it } from "vitest";
import { extractFromBytes, UnreadableFile } from "./index";
import { makeDoc } from "../../../test-support/make-office97";
import { makeZip } from "../../../test-support/make-zip";

const MAX = 1_000_000;

describe("doc", () => {
  it("reads compressed and UTF-16 pieces, Turkish letters whole", async () => {
    const doc = makeDoc([
      // One byte per character: what Word writes when everything fits Windows-1252.
      { text: "Kullanım kılavuzu yok: Gözden “geçir” – ücret €5\r", compressed: false },
      { text: "Merhaba dünya, “alıntı” yok – €5\r", compressed: false },
      { text: "Größe und Preis: “fünf” – €5\r", compressed: true },
      { text: "Şirket İzmir'de: ğüşıöçİ ĞÜŞIÖÇ\r", compressed: false },
    ]);

    const { text } = (await extractFromBytes("kilavuz.doc", doc, MAX))!;

    expect(text).toContain("Größe und Preis: “fünf” – €5");
    expect(text).toContain("Şirket İzmir'de: ğüşıöçİ ĞÜŞIÖÇ");
    expect(text.split("\n")).toHaveLength(4);
  });

  // A hyperlink is `19 HYPERLINK "…" 20 shown text 21`: the reader sees the text.
  it("keeps what a field shows and drops its instruction, nested or not", async () => {
    const doc = makeDoc([
      {
        text: 'Bkz. \x13 HYPERLINK "https://covan.app" \x14bağlantı\x15 ve sayfa \x13 PAGE \x13 SEQ \x14x\x15 \x143\x15.\r',
        compressed: false,
      },
      { text: "Alan yok\x13 TOC \\o \x15 burada\r", compressed: true },
    ]);

    const { text } = (await extractFromBytes("alan.doc", doc, MAX))!;

    expect(text).toContain("Bkz. bağlantı ve sayfa 3.");
    expect(text).toContain("Alan yok burada");
    expect(text).not.toContain("HYPERLINK");
    expect(text).not.toContain("TOC");
  });

  it("turns cell and row marks into tabs and lines, and drops object anchors", async () => {
    const doc = makeDoc([
      { text: "Kıdem\x07Gün\x07\x07", compressed: false },
      { text: "5 yil\x0725\x07\x07Son\x01 satir\x0bikinci\x0csayfa\r", compressed: true },
    ]);

    const { text } = (await extractFromBytes("tablo.doc", doc, MAX))!;

    expect(text).toBe("Kıdem\tGün\n5 yil\t25\nSon satir\nikinci\nsayfa");
  });

  it("reads footnotes after the main text", async () => {
    const main = "Ana metin.\r";
    const doc = makeDoc(
      [
        { text: main, compressed: true },
        { text: "Dipnot: ayrıntı.\r", compressed: false },
      ],
      { ccpText: main.length, ccpFtn: "Dipnot: ayrıntı.\r".length },
    );

    const { text } = (await extractFromBytes("dipnot.doc", doc, MAX))!;

    expect(text).toBe("Ana metin.\n\nDipnot: ayrıntı.");
  });

  it("stops at maxChars and says so", async () => {
    const doc = makeDoc([{ text: "abcdefghij".repeat(100) + "\r", compressed: true }]);
    const got = await extractFromBytes("long.doc", doc, 50);
    expect(got).toEqual({ text: "abcdefghij".repeat(5), truncated: true });
  });

  it("refuses a password-protected document, and says that is why", async () => {
    const doc = makeDoc([{ text: "gizli\r", compressed: true }], { encrypted: true });
    const err = await extractFromBytes("gizli.doc", doc, MAX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableFile);
    expect((err as Error).message).toMatch(/password-protected/);
    expect((err as Error).message).toMatch(/Word/);
  });

  // Word saves RTF and web pages under `.doc` when asked; people rename files.
  it("reads a .doc that is really RTF, HTML or a .docx", async () => {
    const rtf = new TextEncoder().encode(String.raw`{\rtf1\ansi Merhaba d\'fcnya\par}`);
    expect((await extractFromBytes("a.doc", rtf, MAX))!.text).toBe("Merhaba dünya");

    const html = new TextEncoder().encode("<html><body><p>Web sayfası</p></body></html>");
    expect((await extractFromBytes("b.doc", html, MAX))!.text).toBe("Web sayfası");

    const docx = await makeZip({
      "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Aslında docx</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect((await extractFromBytes("c.doc", docx, MAX))!.text).toBe("Aslında docx");
  });
});
