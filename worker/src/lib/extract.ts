// What an upload may be, how big, and how it is served back. Reading a
// document's text lives in `lib/formats/read`; an uploaded PDF is the
// exception, read in the browser at upload time and its text stored beside
// the file. A synced PDF, with no browser behind it, is read on the server by
// `lib/formats/read/pdf.ts`.

import { decodeText } from "./formats/read/text";
import { extOf } from "./formats/read";

export { extOf };

/**
 * The extensions an upload may carry, and the type each one is served as.
 *
 * One table, deliberately. The allowlist used to live in `routes/bundles.ts`
 * with nothing mapping it to a content type, so upload stored the type the
 * *uploader* claimed and download handed that value straight back. A `.pdf`
 * typed `text/html` therefore came back as a `text/html` response, and the
 * preview dialog makes a `blob:` document of the bytes — which runs on this
 * app's own origin, where the session token is readable. The extension is the
 * only thing upload ever validated, so the extension is what the type is
 * derived from, at both ends. Keeping the two lists apart is what let them
 * disagree, so `ALLOWED_EXT` is now the keys of this map rather than a second
 * list beside it.
 */
//
// HTML and XML are served as plain text, never as themselves: either would be
// a document on this origin the moment the preview framed it, which is the
// exact hole the comment above describes.
const TYPE_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  rtf: "application/rtf",
  html: "text/plain; charset=utf-8",
  htm: "text/plain; charset=utf-8",
  xml: "text/plain; charset=utf-8",
};

/** The extensions an upload may carry. Moved from `routes/bundles.ts`. */
export const ALLOWED_EXT: Set<string> = new Set(Object.keys(TYPE_BY_EXT));

/**
 * The largest file an upload may be. `src/lib/uploads.ts` declares the same
 * number as `MAX_SIZE` and `src/lib/uploads.test.ts` reads both files to keep
 * them equal: this one is the authority, that one only saves a person a round
 * trip.
 *
 * It was 10 MB while a document was indexed inside its own upload request.
 * Now the file arrives in parts (`routes/uploads.ts`) and is indexed by a job
 * a few hundred passages at a time (`lib/indexing`), so no request and no unit
 * of work holds the file. What bounds the database is `MAX_INDEX_CHARS`.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The most a single request may upload directly, file and browser-extracted
 * text together, through `POST /bundles/:id/documents/upload`.
 *
 * The one-request route stays for small files and for API callers; the app
 * sends anything larger in parts. Kept under `MAX_REQUEST_BYTES`.
 */
export const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * How much browser-extracted text may come with a direct upload.
 *
 * A PDF's text can outgrow the file it came from — its streams are compressed
 * and the text is not — so the old single limit on the whole body refused a
 * 7 MB PDF that the form had just accepted, because its text pushed the body
 * past 10 MB. Twice the file is generous for any real document and keeps the
 * upload under `MAX_REQUEST_BYTES`.
 */
export const MAX_EXTRACTED_TEXT_BYTES = 2 * MAX_DIRECT_UPLOAD_BYTES;

/**
 * How much of one document's text is indexed.
 *
 * This, not the file size, is what the database pays for: every 850 characters
 * becomes a passage row of about 7 KB (`vector(1536)` and the text), so two
 * million characters — a 700-page book — is some 16 MB of rows. A document
 * longer than this is indexed up to it and marked `partial`, which the
 * Knowledge tab says out loud; nothing past the cut is searchable.
 */
export const MAX_INDEX_CHARS = 2_000_000;

/**
 * The content type a document of this name is stored and served as.
 *
 * Never the client's `file.type`, and never the type recorded in the store
 * either — an object written before this existed already carries whatever its
 * uploader chose, and the row's own name is the one thing about it the server
 * decided. An extension this does not know lands as `application/octet-stream`
 * rather than as a guess: documents are written by four writers and one of them
 * (Drive's readable-MIME branch) keeps a name with no extension at all. That
 * costs nothing a reader sees, because every download also carries
 * `Content-Disposition: attachment`; a wrong type would cost a document on this
 * origin.
 */
export function contentTypeFor(name: string): string {
  return TYPE_BY_EXT[extOf(name)] ?? "application/octet-stream";
}

/**
 * Text from a synced file's bytes, in whatever encoding it was saved.
 * See `decodeText` for why that is not simply UTF-8.
 */
export function decodeFileText(bytes: ArrayBuffer): string {
  return decodeText(new Uint8Array(bytes));
}

// Above this share of replacement characters the "text" is a binary file being
// read as prose, not prose with a few accents lost. A zip container read as
// text lands far higher. (A Windows-1254 file used to land around 15% when it
// was decoded as UTF-8; `decodeText` now reads it as what it is.)
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

/** What a person is told about a file with no text worth indexing. */
export function noTextMessage(name: string): string {
  return extOf(name) === "pdf"
    ? "no readable text in this PDF — it looks like a scan, so run it through OCR and upload the text"
    : "no readable text in this file — check it is really the format its name claims";
}

/**
 * How much of a document's text is kept on the row itself.
 *
 * `documents.content` is the excerpt the no-match fallback in `routes/chat.ts`
 * reads when retrieval finds nothing — "what's in the handbook?" embeds close
 * to no single passage — so it is a second, cruder path to the same text rather
 * than a preview. The full document lives in the store.
 *
 * It moved here from `routes/bundles.ts` when connections started writing
 * documents too. One number: an upload and a sync that disagreed about how much
 * a document remembers would be a difference nobody would think to look for.
 */
export const EXCERPT_LIMIT = 8000;

/**
 * A document's name, reduced to something safe to put in a storage key.
 *
 * Not a display name — `documents.name` keeps the original, accents and all.
 * This is only ever the tail of an object key, where a slash would invent a
 * directory and a non-ASCII byte is one more thing for a storage backend to
 * disagree about.
 */
export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
}
