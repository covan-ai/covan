import OpenAI from "openai";

/**
 * The one place an OpenAI client is constructed for a completion.
 *
 * Covan's claim is that you can run the whole thing yourself, and until this
 * existed that claim had a hole in it: every call site did `new OpenAI({
 * apiKey })` with no `baseURL`, so a self-hosted deployment still sent each
 * question and each answer to api.openai.com. `OPENAI_BASE_URL` closes it —
 * point it at Ollama, vLLM, LiteLLM, OpenRouter, or an Azure-style gateway and
 * the completions go there instead.
 *
 * Two things this does not cover, deliberately:
 *
 * - **Embeddings.** `knowledge_chunks.embedding` is `vector(1536)` (migration
 *   0004) and both match RPCs take that width, so an endpoint serving a
 *   768-dimension model would not fail at the call — it would fail at the
 *   insert, after the upload. Embeddings stay on OpenAI until that is a
 *   migration rather than a variable.
 * - **Transcription.** `/audio/transcriptions` is absent from most
 *   OpenAI-compatible servers, so routing it would trade a working feature for
 *   a 404.
 *
 * Both are stated in docs/self-hosting.md rather than left for someone to
 * discover.
 *
 * The SDK reads `process.env.OPENAI_BASE_URL` by itself, which quietly worked
 * on the Node runtime and never on Workers. Passing it explicitly is what makes
 * the two runtimes behave the same way, which is the whole point of the seam.
 */
export function createOpenAI(env: { OPENAI_API_KEY: string; OPENAI_BASE_URL?: string }): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    // `|| undefined`, not `??`: an unset variable arrives as "" from a .env
    // file, and "" as a baseURL resolves against the Worker's own origin.
    baseURL: env.OPENAI_BASE_URL || undefined,
  });
}
