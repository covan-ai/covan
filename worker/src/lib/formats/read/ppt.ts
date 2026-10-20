import { CfbError, PasswordProtected, u16, u32, type CompoundFile } from "./cfb";
import { decodeLatin1, decodeUtf16, tidy } from "./text";

/**
 * Text out of a PowerPoint 97-2003 `.ppt` ([MS-PPT]), in the shape `pptxText`
 * gives a `.pptx`: `## Slide N`, the slide's text, then `Notes:`.
 *
 * The "PowerPoint Document" stream is a tree of records, each with an
 * eight-byte header (version and instance, type, length); a version of 0xF
 * marks a container whose data is more records. Text is in two kinds of atom:
 * TextCharsAtom (UTF-16 — where any Turkish text is) and TextBytesAtom (one
 * byte per character, the low half of UTF-16, used when every character fits).
 *
 * Where the atoms sit matters. A title or body placeholder's text is kept in
 * the document's slide list, one block per slide; a text box drawn on a slide
 * keeps its text in the slide's own container; notes are in a notes container.
 * Slides and notes are found through the persist directory, which maps the
 * ids the slide list uses to where each container starts in the stream. That
 * also keeps out what a plain walk of the stream would wrongly collect: the
 * masters' "Click to edit Master title style", and old copies of slides an
 * incremental ("fast") save left behind.
 *
 * When that structure is not there to follow — a damaged file, or one some
 * other program wrote more loosely — every text atom outside the masters is
 * read in stream order instead, one block each.
 *
 * Not read: charts, embedded objects, tables' structure (a table is a group
 * of text boxes, so its text comes out but not its grid), comments.
 */

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
/** Drawings nest groups in groups; nothing real goes this deep. */
const MAX_DEPTH = 32;

const DOCUMENT = 0x03e8;
const SLIDE = 0x03ee;
const NOTES = 0x03f0;
const NOTES_ATOM = 0x03f1;
const SLIDE_PERSIST_ATOM = 0x03f3;
const MAIN_MASTER = 0x03f8;
const HANDOUT = 0x0fc9;
const SLIDE_LIST_WITH_TEXT = 0x0ff0;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const PERSIST_DIRECTORY_ATOM = 0x1772;
/** CurrentUserAtom.headerToken of an encrypted deck (an open one has 0xE391C05F). */
const ENCRYPTED_TOKEN = 0xf3d1c4df;

type Rec = { type: number; instance: number; container: boolean; start: number; end: number };

/** The record whose header is at `at`, or null when it does not fit inside `limit`. */
function recordAt(s: Uint8Array, at: number, limit: number): Rec | null {
  if (at + 8 > limit) return null;
  const verInstance = u16(s, at);
  const end = at + 8 + u32(s, at + 4);
  if (end > limit) return null;
  return {
    type: u16(s, at + 2),
    instance: verInstance >> 4,
    container: (verInstance & 0x0f) === 0x0f,
    start: at + 8,
    end,
  };
}

/** The records directly inside `parent` (or the whole stream). Stops at the first that does not fit. */
function children(s: Uint8Array, parent: { start: number; end: number }): Rec[] {
  const out: Rec[] = [];
  let at = parent.start;
  for (let r = recordAt(s, at, parent.end); r; r = recordAt(s, at, parent.end)) {
    out.push(r);
    at = r.end;
  }
  return out;
}

/** One text atom as lines: PowerPoint ends paragraphs with CR and breaks lines with VT. */
function atomText(s: Uint8Array, r: Rec): string {
  const bytes = s.subarray(r.start, r.end);
  const raw = r.type === TEXT_CHARS_ATOM ? decodeUtf16(bytes, true) : decodeLatin1(bytes);
  return (
    raw
      .replace(/[\r\v]/g, "\n")
      // A slide-number or date field is a lone "*" in the text.
      .replace(/^\*$/gm, "")
      .trim()
  );
}

const isText = (r: Rec) => r.type === TEXT_CHARS_ATOM || r.type === TEXT_BYTES_ATOM;

/** Every text atom under `r`, in order, skipping the masters and the handout page. */
function textUnder(s: Uint8Array, r: Rec, out: string[], depth = 0) {
  if (isText(r)) {
    const t = atomText(s, r);
    if (t) out.push(t);
    return;
  }
  if (!r.container || depth > MAX_DEPTH || r.type === MAIN_MASTER || r.type === HANDOUT) return;
  for (const c of children(s, r)) textUnder(s, c, out, depth + 1);
}

/**
 * Persist id → stream offset. Each save appends a directory of what it
 * changed, so later entries override earlier ones.
 */
function persistDirectory(s: Uint8Array, top: Rec[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of top) {
    if (r.type !== PERSIST_DIRECTORY_ATOM) continue;
    let at = r.start;
    while (at + 4 <= r.end) {
      const head = u32(s, at);
      const first = head & 0xfffff;
      const count = head >>> 20;
      at += 4;
      for (let i = 0; i < count && at + 4 <= r.end; i++, at += 4) map.set(first + i, u32(s, at));
    }
  }
  return map;
}

type Slide = { slideId: number; persistId: number; lines: string[] };

function structured(
  s: Uint8Array,
  top: Rec[],
  maxChars: number,
): { slides: Slide[]; notes: Map<number, string> } {
  const doc = top.filter((r) => r.type === DOCUMENT).pop();
  const persist = persistDirectory(s, top);
  const slides: Slide[] = [];
  const notes = new Map<number, string>();
  if (!doc || persist.size === 0) return { slides, notes };

  // Each container is read once, and none once the text is long enough: a
  // directory pointing every slide at one huge container is not a reason to
  // read it a thousand times.
  const read = new Set<number>();
  let collected = 0;
  const containerAt = (persistId: number, type: number): Rec | null => {
    const at = persist.get(persistId);
    if (at === undefined || read.has(at) || collected > maxChars) return null;
    read.add(at);
    const r = recordAt(s, at, s.length);
    return r && r.type === type && r.container ? r : null;
  };

  const notesIds: number[] = [];
  for (const list of children(s, doc)) {
    if (list.type !== SLIDE_LIST_WITH_TEXT) continue;
    // Instance 0 lists the slides, 1 the masters, 2 the notes pages.
    if (list.instance !== 0 && list.instance !== 2) continue;
    let current: Slide | null = null;
    for (const c of children(s, list)) {
      if (c.type === SLIDE_PERSIST_ATOM && c.end - c.start >= 16) {
        const persistId = u32(s, c.start);
        if (list.instance === 2) {
          notesIds.push(persistId);
          continue;
        }
        current = { persistId, slideId: u32(s, c.start + 12), lines: [] };
        slides.push(current);
      } else if (current && list.instance === 0 && isText(c)) {
        const t = atomText(s, c);
        if (t) current.lines.push(t);
        collected += t.length;
      }
    }
  }

  for (const slide of slides) {
    const container = containerAt(slide.persistId, SLIDE);
    if (!container) continue;
    const extra: string[] = [];
    textUnder(s, container, extra);
    // A placeholder's text belongs to the slide list; a writer that also
    // copies it into the shape should not make it read twice.
    const seen = new Set(slide.lines);
    for (const t of extra) {
      if (seen.has(t)) continue;
      slide.lines.push(t);
      collected += t.length;
    }
  }

  for (const id of notesIds) {
    const container = containerAt(id, NOTES);
    if (!container) continue;
    const parts = children(s, container);
    const atom = parts.find((p) => p.type === NOTES_ATOM && p.end - p.start >= 4);
    if (!atom) continue;
    const lines: string[] = [];
    for (const p of parts) textUnder(s, p, lines);
    // A notes page repeats the slide number as text; it says nothing.
    const text = lines.join("\n").replace(/^\d+$/gm, "").trim();
    if (text) notes.set(u32(s, atom.start), text);
    collected += text.length;
  }
  return { slides, notes };
}

export async function pptText(
  cfb: CompoundFile,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (cfb.has("EncryptedSummary")) throw new PasswordProtected();
  // An encrypted deck need not have an EncryptedSummary stream; what always
  // says so is the token in the Current User stream's one record.
  // Only a hint, so a damaged one is not a reason to refuse the deck.
  const user = await cfb.stream("Current User", 64 * 1024).catch(() => null);
  if (user && user.length >= 16 && u32(user, 12) === ENCRYPTED_TOKEN) {
    throw new PasswordProtected();
  }
  const s = await cfb.stream("PowerPoint Document", MAX_STREAM_BYTES);
  if (!s) throw new CfbError("not a PowerPoint deck (no PowerPoint Document stream)");
  const top = children(s, { start: 0, end: s.length });
  if (top.length === 0) throw new CfbError("not a PowerPoint deck (no records)");

  const out: string[] = [];
  let length = 0;
  const add = (block: string) => {
    if (!block || length > maxChars) return;
    out.push(block);
    length += block.length + 2;
  };

  const { slides, notes } = structured(s, top, maxChars);
  // A deck with a slide list is believed even when its slides are empty: the
  // walk below would find nothing but a title master's or notes master's
  // prompts ("Click to edit Master text styles").
  if (slides.length > 0) {
    const hasText = slides.some((sl) => sl.lines.length > 0 || notes.has(sl.slideId));
    if (!hasText) return { text: "", truncated: false };
    slides.forEach((slide, i) => {
      const parts = [`## Slide ${i + 1}`, slide.lines.join("\n")];
      const note = notes.get(slide.slideId);
      if (note) parts.push(`Notes: ${note}`);
      add(parts.filter(Boolean).join("\n\n"));
    });
  } else {
    for (const r of top) {
      const blocks: string[] = [];
      textUnder(s, r, blocks);
      blocks.forEach(add);
    }
  }
  return { text: tidy(out.join("\n\n")), truncated: length > maxChars };
}
