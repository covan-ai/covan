import type { DocStore } from "./docstore";
import { EXCERPT_LIMIT, extractDocumentText } from "./extract";

/**
 * Where a document's full extracted text is kept, beside its original.
 *
 * Only written when the server cannot read the original itself — today a PDF,
 * whose text the browser extracted and sent with it. Every reader that needed
 * the whole text afterwards (reindex, the operator backfill) used to fall back
 * to `documents.content`, which is the first `EXCERPT_LIMIT` characters, and a
 * reindex of a 300-page PDF quietly made it an eight-page one.
 */
export function sidecarKey(key: string): string {
  return `${key}.txt`;
}

/** Every stored object that belongs to a document stored under `key`. */
export function storedKeysOf(key: string): string[] {
  return [key, sidecarKey(key)];
}

/**
 * The fullest text of a document that can be had, and whether it is all of it.
 *
 * In order: the sidecar, then the original re-extracted, then the excerpt on
 * the row. `complete` is false only for the last, when the excerpt is as long as
 * an excerpt gets — the one case where what came back is known to be a prefix.
 * Throws only if the store itself does.
 */
export async function fullTextOf(
  /** Null where there is nothing stored to read, and the excerpt is all there is. */
  store: DocStore | null,
  doc: { name: string; r2_key: string | null; content: string | null },
): Promise<{ text: string; complete: boolean }> {
  if (store && doc.r2_key) {
    const sidecar = await store.get(sidecarKey(doc.r2_key));
    if (sidecar) {
      const text = new TextDecoder().decode(await sidecar.arrayBuffer());
      if (text.trim()) return { text, complete: true };
    }
    const original = await store.get(doc.r2_key);
    if (original) {
      const text = extractDocumentText(doc.name, await original.arrayBuffer());
      if (text.trim()) return { text, complete: true };
    }
  }
  const excerpt = doc.content ?? "";
  return { text: excerpt, complete: excerpt.length < EXCERPT_LIMIT };
}
