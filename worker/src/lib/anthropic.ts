import Anthropic from "@anthropic-ai/sdk";

/**
 * The one place an Anthropic client is constructed.
 *
 * The same seam `lib/openai.ts` is, for the same reason: one factory means one
 * place where the base URL, the key and the timeout are decided, and a sixth
 * call site cannot quietly reopen a hole by newing up its own. `openai.test.ts`
 * walks the source to keep that true for OpenAI; `anthropic.test.ts` does it
 * here.
 *
 * `ANTHROPIC_BASE_URL` exists for the same reason `OPENAI_BASE_URL` does — an
 * Anthropic-compatible gateway (a proxy, a corporate egress point, a recording
 * middlebox in a regulated environment) is a legitimate place to send these
 * requests, and a self-hosted deployment should not have to patch the source to
 * use one. Unset means api.anthropic.com.
 */
export function createAnthropic(env: {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    // Reached only by a bug: `resolveModel` will not return a Claude id unless
    // this key is set, so a request that arrives here without one has routed
    // itself wrongly. Saying so beats a 401 from Anthropic that reads like a
    // bad key rather than a missing one.
    throw new Error(
      "ANTHROPIC_API_KEY is not set, so no Claude model can be served. " +
        "This request should never have been routed to Anthropic — see lib/models.ts.",
    );
  }
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // `|| undefined`, not `??`: an unset variable arrives as "" from a .env
    // file, and "" as a baseURL resolves against the Worker's own origin.
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
  });
}
