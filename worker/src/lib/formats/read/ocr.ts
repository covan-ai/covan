import { createAnthropic } from "../../anthropic";

/**
 * The text of a PDF that has none of its own — a scan, a photographed page —
 * read by Claude, which takes a PDF as a document and reads its pages as
 * images as well as text.
 *
 * Used by the indexing job when the browser found no text layer. A scanned
 * PDF used to be refused at upload with "run it through OCR and upload the
 * text", which is advice most people cannot take. Now it is accepted and read
 * here, and the workspace is charged for the call like any other completion.
 *
 * Bounded by what one request can carry: Claude takes a PDF of up to 32 MB
 * and 100 pages, and base64 makes a file a third bigger, so the file limit is
 * 24 MB. Past that, or past 100 pages, the job fails with a reason rather than
 * reading part of it without saying so. The transcript is cut at
 * `MAX_OUTPUT_TOKENS`; `truncated` says when it was.
 */

/** The largest file one request can carry once base64 has grown it. */
export const OCR_MAX_BYTES = 24 * 1024 * 1024;

const MAX_OUTPUT_TOKENS = 16_000;

/** Cheap, and reads pages well. `OCR_MODEL` overrides it. */
const DEFAULT_OCR_MODEL = "claude-haiku-4-5";

const PROMPT =
  "Transcribe all of the text in this document, page by page, in reading order. " +
  "Keep headings as Markdown headings, lists as lists, and tables as Markdown tables. " +
  "Do not summarise, translate, correct or comment — write exactly what the pages say, " +
  'and nothing else. Put "---" between pages.';

export type OcrEnv = {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OCR_MODEL?: string;
};

export function ocrAvailable(env: OcrEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export type OcrResult = {
  text: string;
  truncated: boolean;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
};

export async function ocrPdf(env: OcrEnv, bytes: Uint8Array): Promise<OcrResult> {
  const model = env.OCR_MODEL || DEFAULT_OCR_MODEL;
  const client = createAnthropic(env);
  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) },
          },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return {
    text,
    truncated: response.stop_reason === "max_tokens",
    model,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}

/** Base64 without `Buffer`, which Workers lack, in slices `fromCharCode` can take. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
