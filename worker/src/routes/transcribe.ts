import { Hono } from "hono";
import type { AppEnv } from "../types";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";
import { transcriptionCost } from "../lib/entitlements";
import { transcribeAudio } from "../lib/transcribe";

const transcribe = new Hono<AppEnv>();

// What a browser produces, plus the neighbouring formats OpenAI accepts anyway.
// Chrome and Firefox record webm/opus; Safari records mp4/aac.
const ALLOWED_EXT = new Set(["webm", "mp4", "m4a", "mp3", "wav", "ogg", "oga", "flac"]);

// Two minutes of speech, with room for a codec less thrifty than opus. The
// composer stops recording at two minutes; this is the same limit expressed in
// the only unit the server can check without decoding the audio.
const MAX_SIZE = 2 * 1024 * 1024;

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

// POST /transcribe — multipart `file`; returns the text to put in the composer.
transcribe.post("/transcribe", async (c) => {
  // Before the audio goes anywhere. The spend happens at OpenAI, and there is
  // no way to un-transcribe a recording once it has been sent.
  const denied = await guardQuota(c);
  if (denied) return denied;

  const contentLength = parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_SIZE) {
    return c.json({ error: "recording too long (max 2 minutes)" }, 413);
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no recording provided" }, 400);
  if (!ALLOWED_EXT.has(extOf(file.name))) return c.json({ error: "unsupported audio format" }, 400);
  if (file.size === 0) return c.json({ error: "empty recording" }, 400);
  if (file.size > MAX_SIZE) return c.json({ error: "recording too long (max 2 minutes)" }, 413);

  let result;
  try {
    result = await transcribeAudio(c.env.OPENAI_API_KEY, file);
  } catch (err) {
    console.error("transcription failed", err);
    return c.json({ error: "could not transcribe the recording" }, 502);
  }

  // Charged before the answer is shaped, and charged either way: the audio was
  // sent and billed whether or not there turned out to be a sentence in it.
  await recordQuota(c, transcriptionCost(result.audioTokens));

  // Heard nothing. A 200 with an empty string would leave the composer
  // unchanged and the button looking broken, so the silence is stated instead.
  // Trimmed here as well as in `transcribeAudio`, so what reaches the composer
  // is decided by the endpoint that answers it rather than by its supplier.
  const text = result.text.trim();
  if (text.length === 0) {
    return c.json({ error: "no speech in the recording" }, 422);
  }

  return c.json({ text });
});

export { transcribe };
