// The client-side half of the upload gate. The server checks all of this again
// (`worker/src/routes/bundles.ts`) and is the authority; this exists so a file
// that was never going to be accepted is refused before it is sent, with a
// sentence naming the file rather than a status code.
//
// Shared by the Knowledge tab, the chat composer and the create-agent dialog so
// the three surfaces cannot drift into disagreeing about what an acceptable
// file is.

export const ALLOWED_EXT = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "odt",
  "rtf",
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "json",
  "html",
  "htm",
  "xml",
] as const;

/** The `accept` attribute every file picker uses, from the one list above. */
export const ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(",");

// The same number as `MAX_UPLOAD_BYTES` in `worker/src/lib/extract.ts`, which is
// the one that is enforced. `uploads.test.ts` reads both files and fails when
// they disagree; this copy exists because the frontend cannot import from the
// worker's tree.
export const MAX_SIZE = 100 * 1024 * 1024;

// What the extension list is called when a person has to read it. `markdown` is
// left out on purpose: it is the same format as `md` and naming both explains
// nothing.
const SPOKEN_EXT = "pdf, docx, pptx, xlsx, odt, rtf, md, txt, csv, json, html";

/** The characters after the last dot, lowercased. "" when there is no dot. */
export function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

export type UploadCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a picked file is worth sending. Reads the name and the size
 * only — the same two things the server can check before it has the bytes.
 */
export function validateUpload(file: { name: string; size: number }): UploadCheck {
  const ext = extOf(file.name);
  if (!(ALLOWED_EXT as readonly string[]).includes(ext)) {
    return { ok: false, reason: `${file.name}: unsupported type (${SPOKEN_EXT})` };
  }
  if (file.size === 0) {
    return { ok: false, reason: `${file.name}: the file is empty` };
  }
  if (file.size > MAX_SIZE) {
    return { ok: false, reason: `${file.name}: too large (max 100 MB)` };
  }
  return { ok: true };
}
