import type { DocStore } from "./docstore";
import { EXCERPT_LIMIT } from "./extract";
import { extractText } from "./formats/read";

/**
 * Where a document's full extracted text is kept, beside its original.
 *
 * Written for a PDF by its upload, whose text the browser extracted, and for
 * every other format by the first unit of its indexing job — after which every
 * later unit, and every reindex, reads this instead of opening the original
 * again. Readers that needed the whole text used to fall back to
 * `documents.content`, the first `EXCERPT_LIMIT` characters, and a reindex of a
 * 300-page PDF quietly made it an eight-page one.
 */
export function sidecarKey(key: string): string {
  return `${key}.txt`;
}

/** Every stored object that belongs to a document stored under `key`. */
export function storedKeysOf(key: string): string[] {
  return [key, sidecarKey(key)];
}

export type StoredText = {
  text: string;
  /** Cut at `maxChars`; everything before the cut is in `text`. */
  truncated: boolean;
  /** Read from the sidecar rather than worked out from the original. */
  fromSidecar: boolean;
};

/**
 * The fullest text of a document that can be had, at most `maxChars` of it —
 * or null when there is nothing fuller than a cut excerpt.
 *
 * In order: the sidecar; then the original, read through ranges so a 100 MB
 * file is never held whole (`lib/formats/read`); then the excerpt on the row,
 * but only when it is short enough to be the whole text. Null is what an old
 * PDF uploaded before sidecars existed gets, and the caller must refuse rather
 * than index eight thousand characters as though they were the document.
 * Throws `UnreadableFile` for an original that is not what its name says.
 */
export async function readStoredText(
  store: DocStore | null,
  doc: { name: string; r2_key: string | null; content: string | null },
  maxChars: number,
): Promise<StoredText | null> {
  if (store && doc.r2_key) {
    const sidecar = await store.get(sidecarKey(doc.r2_key));
    if (sidecar) {
      const text = new TextDecoder().decode(await sidecar.arrayBuffer());
      if (text.trim()) {
        return {
          text: text.slice(0, maxChars),
          truncated: text.length > maxChars,
          fromSidecar: true,
        };
      }
    }

    const key = doc.r2_key;
    const head = await store.getRange(key, 0, 0);
    if (head) {
      const read = async (offset: number, length: number) =>
        (await store.getRange(key, offset, length))?.bytes ?? new Uint8Array(0);
      const extracted = await extractText(doc.name, read, head.size, maxChars);
      if (extracted && extracted.text.trim()) return { ...extracted, fromSidecar: false };
    }
  }

  const excerpt = doc.content ?? "";
  if (excerpt.trim() && excerpt.length < EXCERPT_LIMIT) {
    return { text: excerpt, truncated: false, fromSidecar: false };
  }
  return null;
}
