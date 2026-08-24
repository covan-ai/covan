// Real OpenAI model ids the app supports. The frontend now stores one of these
// strings on each agent; legacy/unknown values (old "GPT-4", "Claude ...", etc.)
// resolve to the default so existing agents keep working.
export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"] as const;
export const DEFAULT_MODEL = "gpt-4o";

/**
 * Which model a completion should ask for.
 *
 * The allowlist above is a list of OpenAI's names, so it only means anything
 * while the requests go to OpenAI. An operator who sets OPENAI_BASE_URL is
 * talking to a server whose catalogue we cannot know, and every agent's stored
 * model would resolve to `gpt-4o` — a name that endpoint has never heard of.
 * OPENAI_MODEL is the answer: set it and it wins outright, per-agent picker
 * included. The picker in the UI still lists OpenAI's models; that it has no
 * effect under a custom endpoint is noted in docs/self-hosting.md.
 */
export function resolveModel(
  model: string | null | undefined,
  env?: { OPENAI_MODEL?: string },
): string {
  if (env?.OPENAI_MODEL) return env.OPENAI_MODEL;
  return model && (OPENAI_MODELS as readonly string[]).includes(model) ? model : DEFAULT_MODEL;
}
