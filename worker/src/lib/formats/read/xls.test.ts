import { describe, expect, it } from "vitest";
import { extractFromBytes, UnreadableFile } from "./index";
import {
  biff,
  bytes8,
  le16,
  le32,
  makeWorkbook,
  makeXls,
  utf16,
  xl,
} from "../../../test-support/make-office97";

const MAX = 1_000_000;

/**
 * A shared string table that runs over two CONTINUE records, the way Excel
 * splits a long one: string 2 is cut in the middle of its characters, and the
 * CONTINUE re-sends the option byte, switching the rest from one byte per
 * character to UTF-16; string 3's formatting runs are cut between the two
 * CONTINUEs, with no option byte, because they are not characters.
 */
function sharedStrings(): number[][] {
  const compressed = (s: string) => [...le16(s.length), 0x00, ...bytes8(s)];
  const sst = [
    ...le32(5),
    ...le32(5),
    ...compressed("Ürün"),
    ...compressed("Fiyat, TL"),
    ...le16("Toplam ağırlık".length),
    0x00,
    ...bytes8("Toplam a"),
  ];
  const rich = [...le16(5), 0x09, ...le16(1), ...utf16("Kalın")];
  const continue1 = [0x01, ...utf16("ğırlık"), ...rich, 0x01, 0x00];
  const continue2 = [
    0x00,
    0x00,
    ...[...le16(3), 0x04, ...le32(6), ...bytes8("Not"), 1, 2, 3, 4, 5, 6],
  ];
  return [biff(0x00fc, sst), biff(0x003c, continue1), biff(0x003c, continue2)];
}

describe("xls", () => {
  it("reads every sheet as CSV under its name, like a .xlsx", async () => {
    const workbook = makeWorkbook(
      [
        {
          name: "Fiyatlar",
          cells: [
            xl.labelSst(0, 0, 0),
            xl.labelSst(0, 1, 1),
            xl.labelSst(1, 0, 2),
            xl.number(1, 1, 12.5),
            xl.labelSst(2, 0, 3),
            xl.rk(2, 1, (42 << 2) | 0x02),
            xl.labelSst(3, 0, 4),
            // 1234 in hundredths, and an integer.
            xl.mulrk(3, 1, [(1234 << 2) | 0x03, (-7 << 2) | 0x02]),
            xl.formulaString(4, 0, "Hesaplandı"),
            xl.boolerr(4, 2, 1, false),
            xl.boolerr(4, 3, 0x07, true),
          ],
        },
        { name: "Şube Notları", cells: [xl.label(0, 1, "İzmir, Konak")] },
      ],
      sharedStrings(),
    );

    const { text, truncated } = (await extractFromBytes("fiyat.xls", makeXls(workbook), MAX))!;

    expect(text).toBe(
      [
        "## Sheet: Fiyatlar",
        "",
        'Ürün,"Fiyat, TL"',
        "Toplam ağırlık,12.5",
        "Kalın,42",
        "Not,12.34,-7",
        "Hesaplandı,,TRUE,#DIV/0!",
        "",
        "## Sheet: Şube Notları",
        "",
        ',"İzmir, Konak"',
      ].join("\n"),
    );
    expect(truncated).toBe(false);
  });

  // A chart inside a sheet is a whole BOF…EOF substream; its records are not cells.
  it("skips a chart embedded in a sheet, and keeps reading the sheet after it", async () => {
    const workbook = makeWorkbook([
      {
        name: "Veri",
        cells: [
          xl.label(0, 0, "önce"),
          xl.bof(0x0020),
          xl.number(0, 1, 99),
          xl.eof(),
          xl.label(1, 0, "sonra"),
        ],
      },
    ]);
    const { text } = (await extractFromBytes("grafik.xls", makeXls(workbook), MAX))!;
    expect(text).toBe("## Sheet: Veri\n\nönce\nsonra");
  });

  it("stops at maxChars and says so", async () => {
    const cells = Array.from({ length: 200 }, (_, i) => xl.label(i, 0, `satır ${i}`));
    const workbook = makeWorkbook([
      { name: "Uzun", cells },
      { name: "İkinci", cells },
    ]);
    const got = (await extractFromBytes("uzun.xls", makeXls(workbook), 300))!;
    expect(got.truncated).toBe(true);
    expect(got.text.length).toBe(300);
    expect(got.text).not.toContain("İkinci");
  });

  it("refuses a workbook with a password to open it", async () => {
    const workbook = makeWorkbook([{ name: "Gizli", cells: [] }], [biff(0x002f, [0, 0, 1, 0])]);
    const err = await extractFromBytes("gizli.xls", makeXls(workbook), MAX).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnreadableFile);
    expect((err as Error).message).toMatch(/password-protected.*Excel/);
  });

  // Web apps export an HTML table as `.xls`, because Excel opens it.
  it("reads an .xls that is really an HTML table", async () => {
    const html = new TextEncoder().encode(
      "<table><tr><td>Ad</td><td>Tutar</td></tr><tr><td>Ayşe</td><td>12</td></tr></table>",
    );
    const { text } = (await extractFromBytes("ekstre.xls", html, MAX))!;
    expect(text).toContain("Ayşe | 12");
  });

  it("says a compound file with no workbook in it is not an .xls", async () => {
    const { makeCfb } = await import("../../../test-support/make-cfb");
    const err = await extractFromBytes("x.xls", makeCfb({ Other: new Uint8Array(10) }), MAX).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnreadableFile);
    expect((err as Error).message).toMatch(/no Workbook stream/);
  });
});
