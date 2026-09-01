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
 * One thing this does not cover, deliberately: **transcription**.
 * `/audio/transcriptions` is absent from most OpenAI-compatible servers, so
 * routing it would trade a working feature for a 404. It is stated in
 * docs/self-hosting.md rather than left for someone to discover.
 *
 * Embeddings used to be a second exception and are not any more — see
 * `createEmbeddingClient` below for why they get a variable of their own
 * instead of sharing this one.
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

/**
 * The same seam for embeddings, on a variable of its own.
 *
 * Embedding is where the whole text of a document is sent, so a deployment that
 * routes completions away from OpenAI and still embeds there has not kept its
 * documents in-house — it has kept its conversations in-house, which is the
 * smaller half. `EMBEDDING_BASE_URL` is what closes that.
 *
 * It deliberately does **not** fall back to `OPENAI_BASE_URL`, for two reasons
 * that point the same way:
 *
 * - An install that today sets `OPENAI_BASE_URL=…ollama…` works: completions go
 *   to Ollama, embeddings go to OpenAI. Inheriting would move its embeddings on
 *   upgrade, to an endpoint whose model almost certainly has a different width,
 *   and the first thing the operator would notice is uploads arriving with no
 *   chunks.
 * - The two are not one decision. Serving completions is table stakes for an
 *   OpenAI-compatible server; serving embeddings at the width your database
 *   column was declared with is not. Somebody may legitimately want one moved
 *   and not the other.
 *
 * So the operator sets both, knowingly, and `docs/self-hosting.md` says so.
 */
export function createEmbeddingClient(env: {
  OPENAI_API_KEY: string;
  EMBEDDING_BASE_URL?: string;
}): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    // Spelled out rather than left `undefined`, which is where "does not
    // inherit" would have quietly stopped being true. The SDK falls back to
    // `process.env.OPENAI_BASE_URL` when given no baseURL — harmless on
    // Workers, where there is no process.env, and not harmless at all in the
    // Docker stack, where compose puts OPENAI_BASE_URL there. An operator who
    // pointed completions at Ollama would have found their documents going to
    // Ollama too, on one runtime out of two, having configured nothing of the
    // sort. Naming the default is what makes the two behave the same.
    baseURL: env.EMBEDDING_BASE_URL || "https://api.openai.com/v1",
  });
}
