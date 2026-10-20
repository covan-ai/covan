import { UnreadableFile, type Extracted } from "./index";

/**
 * A PDF's text layer, read by the server.
 *
 * For the files nobody's browser hands us: a Drive sync runs in a cron tick,
 * and there is no page open to run pdf.js in. Uploads still read their PDFs in
 * the browser and keep the text beside the file; this is for everything that
 * arrives without one.
 *
 * `unpdf` and not `pdfjs-dist`. The note this replaces said pdf.js does not
 * bundle for the Workers runtime, which is true of `pdfjs-dist` — it wants a
 * worker thread and a canvas — and not of unpdf, which ships a serverless
 * build of the same library for exactly this. Measured under `wrangler dev`
 * (workerd): a 19-page specification read in 280 ms, 36,000 characters.
 * It adds about 2.4 MB to the bundle uncompressed, so it is imported when a PDF
 * turns up rather than at startup.
 *
 * A PDF with no text layer — a scan — reads as an empty string here, which is
 * an answer and not an error: the caller decides whether to send it to Claude
 * (`ocr.ts`) or to say why it was not imported.
 */
export async function pdfText(bytes: Uint8Array, maxChars: number): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let text: string;
  try {
    // A copy: pdf.js takes ownership of the buffer it is given and detaches
    // it, and the caller may still want the bytes — to store, or to send to
    // Claude when there was no text in them.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    text = (await extractText(pdf, { mergePages: true })).text;
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "PasswordException") {
      throw new UnreadableFile(
        "this PDF is password-protected — remove the password and try again",
      );
    }
    throw new UnreadableFile(
      `this does not read as a PDF (${(err as Error)?.message ?? String(err)}) — check it opens`,
    );
  }
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}
