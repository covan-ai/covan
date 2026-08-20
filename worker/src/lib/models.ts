// Real OpenAI model ids the app supports. The frontend now stores one of these
// strings on each agent; legacy/unknown values (old "GPT-4", "Claude ...", etc.)
// resolve to the default so existing agents keep working.
export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"] as const;
export const DEFAULT_MODEL = "gpt-4o";
export function resolveModel(model: string | null | undefined): string {
  return model && (OPENAI_MODELS as readonly string[]).includes(model) ? model : DEFAULT_MODEL;
}
