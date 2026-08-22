// Text extraction for uploaded documents. Plain-text formats (md/txt/csv/json)
// are decoded directly. PDFs are NOT parsed here — pdf.js does not bundle
// reliably for the Workers runtime, so the browser extracts PDF text at upload
// time and sends it alongside the file (see the client uploader). This function
// therefore returns "" for PDFs; the caller uses the client-provided text.

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * Decode indexable UTF-8 text from an uploaded file's bytes. Returns "" for
 * PDFs (their text is supplied by the client) and for anything undecodable.
 */
export function extractDocumentText(fileName: string, bytes: ArrayBuffer): string {
  if (extOf(fileName) === "pdf") return "";
  return new TextDecoder().decode(bytes);
}

// Above this share of replacement characters the "text" is a binary file being
// read as prose, not prose with a few accents lost. A Windows-1254 Turkish
// document decoded as UTF-8 lands around 15%; a zip container lands far higher.
const MAX_REPLACEMENT_RATIO = 0.3;

// Spelled as codepoints because both are invisible in a source file: NUL renders
// as nothing at all, and U+FFFD is easily mistaken for a font fallback box.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Whether extracted text is worth indexing — the check that separates a
 * document from a file that merely uploaded successfully.
 *
 * Two things get past extraction looking like text and are not. A PDF with no
 * text layer (a scan, a page of screenshots) extracts to nothing, chunks to
 * nothing, and lands as a document that is listed, downloadable and impossible
 * to retrieve a word of. And a binary file wearing a text extension — the
 * classic being a `.docx` renamed to `.txt`, since the gate reads the name and
 * never the bytes — decodes to mojibake that is then chunked and embedded as
 * though it were prose, where it matches nothing and quietly costs its share of
 * the embedding budget.
 */
export function hasIndexableText(text: string): boolean {
  if (text.trim().length === 0) return false;
  // A NUL is the cheapest tell: no text format contains one, every container
  // format does.
  if (text.includes(NUL)) return false;
  const replacements = text.split(REPLACEMENT).length - 1;
  return replacements / text.length <= MAX_REPLACEMENT_RATIO;
}
