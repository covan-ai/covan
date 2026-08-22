import OpenAI from "openai";

export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/**
 * What a second of dictation is worth in the two units this file has to convert
 * between. `gpt-4o-mini-transcribe` bills audio at ~40 tokens a second, and the
 * composer records at 32 kbps — 4000 bytes a second — so either one can stand in
 * for a duration nobody measured.
 */
const AUDIO_TOKENS_PER_SECOND = 40;
const RECORDED_BYTES_PER_SECOND = 4000;

export type Transcription = {
  /** What was said. */
  text: string;
  /** What the call cost, for usage accounting. */
  audioTokens: number;
};

/**
 * The shape the API actually returns. The SDK pinned here (4.104) types a
 * transcription as `{ text }` and nothing else, but the gpt-4o transcribe models
 * report their usage alongside it, so the field is read defensively rather than
 * declared.
 */
type UsageBearing = {
  usage?: { input_token_details?: { audio_tokens?: number } };
};

/**
 * Transcribes one recording. Returns the text and what it cost. Throws on API
 * error.
 *
 * The cost comes back with the text for the same reason `embedTexts` returns its
 * token count: dictation is real spend, and an operation that reports no cost is
 * an operation nobody is charged for. Where the two differ is the fallback —
 * embeddings can honestly report zero when usage is missing because the caller
 * has the text either way, while a transcription with no usage would make
 * dictation free. So the size of the recording stands in for the duration.
 */
export async function transcribeAudio(apiKey: string, file: File): Promise<Transcription> {
  const openai = new OpenAI({ apiKey });
  const res = await openai.audio.transcriptions.create({ model: TRANSCRIPTION_MODEL, file });

  const billed = (res as UsageBearing).usage?.input_token_details?.audio_tokens;
  const audioTokens =
    typeof billed === "number" && billed > 0
      ? billed
      : Math.max(1, Math.round((file.size / RECORDED_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND));

  return { text: res.text.trim(), audioTokens };
}
