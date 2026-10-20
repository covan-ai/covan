import { describe, expect, it } from "vitest";
import { extractFromBytes, UnreadableFile } from "./index";
import {
  makePpt,
  notesAtom,
  persistDirectory,
  pptAtom,
  pptContainer,
  slidePersist,
  textBytes,
  textChars,
} from "../../../test-support/make-office97";

const MAX = 1_000_000;

const DOCUMENT = 0x03e8;
const SLIDE = 0x03ee;
const NOTES = 0x03f0;
const MAIN_MASTER = 0x03f8;
const SLWT = 0x0ff0;
const DRAWING = 0x040c;
const CLIENT_TEXTBOX = 0xf00d;
const TEXT_HEADER = 0x0f9f;

const header = () => pptAtom(TEXT_HEADER, [0, 0, 0, 0]);

/**
 * A deck the way PowerPoint lays one out: the document's slide list holds the
 * placeholders' text, each slide's own container a drawn text box, a notes
 * container the speaker notes, and the persist directory says where each
 * container is. A master with its prompt text sits in the stream too, and
 * must not be read.
 */
function deck(): number[] {
  const slide1 = pptContainer(SLIDE, [
    pptContainer(DRAWING, [pptContainer(CLIENT_TEXTBOX, [header(), textBytes("Kutu: 3. çeyrek")])]),
  ]);
  const slide2 = pptContainer(SLIDE, [pptContainer(DRAWING, [])]);
  const notes1 = pptContainer(NOTES, [
    notesAtom(256),
    pptContainer(DRAWING, [
      pptContainer(CLIENT_TEXTBOX, [textChars("Bunu yüksek sesle söyle"), textChars("1")]),
    ]),
  ]);
  const master = pptContainer(MAIN_MASTER, [textChars("Click to edit Master title style")]);

  const document = pptContainer(DOCUMENT, [
    pptContainer(
      SLWT,
      [
        slidePersist(2, 256),
        header(),
        textChars("Satış Planı\rİkinci satır"),
        slidePersist(3, 257),
        header(),
        textBytes("Second slide"),
      ],
      0,
    ),
    pptContainer(SLWT, [slidePersist(4, 0)], 2),
    // The masters' list: its text is the masters', which are not read.
    pptContainer(SLWT, [slidePersist(9, 0), textChars("Master body")], 1),
  ]);

  const parts = [document, master, slide1, slide2, notes1];
  const offsets: number[] = [];
  let at = 0;
  for (const p of parts) {
    offsets.push(at);
    at += p.length;
  }
  // Persist ids 1–4: the document, slide 1, slide 2, the notes page.
  return [
    ...parts.flat(),
    ...persistDirectory(1, [offsets[0], offsets[2], offsets[3], offsets[4]]),
  ];
}

describe("ppt", () => {
  it("reads slides in order, with their text boxes and notes, and not the masters", async () => {
    const { text } = (await extractFromBytes("plan.ppt", makePpt(deck()), MAX))!;

    expect(text).toBe(
      [
        "## Slide 1",
        "",
        "Satış Planı\nİkinci satır\nKutu: 3. çeyrek",
        "",
        "Notes: Bunu yüksek sesle söyle",
        "",
        "## Slide 2",
        "",
        "Second slide",
      ].join("\n"),
    );
    expect(text).not.toContain("Master");
  });

  // Without a slide list to follow, every text atom is read in stream order.
  it("falls back to every text atom when there is no structure to follow", async () => {
    const stream = [
      ...pptContainer(0x0fd0, [
        textChars("Çalışma takvimi"),
        pptContainer(0x0fd1, [textBytes("Agenda")]),
      ]),
      ...pptContainer(MAIN_MASTER, [textChars("Click to edit Master title style")]),
      ...textBytes("*"),
    ];

    const { text } = (await extractFromBytes("eski.ppt", makePpt(stream), MAX))!;

    expect(text).toBe("Çalışma takvimi\n\nAgenda");
  });

  it("stops at maxChars and says so", async () => {
    const stream = Array.from({ length: 50 }, (_, i) => textChars(`Slayt metni ${i}`)).flat();
    const got = (await extractFromBytes("uzun.ppt", makePpt(stream), 100))!;
    expect(got.truncated).toBe(true);
    expect(got.text.length).toBe(100);
  });

  it("refuses a password-protected deck", async () => {
    const file = makePpt(textChars("gizli"), { EncryptedSummary: new Uint8Array(16) });
    const err = await extractFromBytes("gizli.ppt", file, MAX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableFile);
    expect((err as Error).message).toMatch(/password-protected.*PowerPoint/);
  });

  // A record claiming more bytes than its container has is where the damage
  // starts; what came before it is still read.
  it("reads what it can of a deck whose records stop making sense", async () => {
    const stream = [...textChars("Sağlam"), 0x00, 0x00, 0xa0, 0x0f, 0xff, 0xff, 0xff, 0x7f, 0x41];
    const { text } = (await extractFromBytes("bozuk.ppt", makePpt(stream), MAX))!;
    expect(text).toBe("Sağlam");
  });
});
