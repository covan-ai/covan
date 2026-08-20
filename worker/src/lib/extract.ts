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
