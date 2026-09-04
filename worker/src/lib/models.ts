// The model ids this build knows how to talk to, and what each one needs.
//
// The list used to be OpenAI's alone, which is why the completion path was one
// SDK and one base URL. It is now two providers, so a model id is no longer
// just a string passed through: it decides which client answers the call, and
// which request fields that client will accept. `lib/completion.ts` is the one
// place that reads `provider`; everything else keeps passing ids around.
//
// Legacy/unknown values (old "GPT-4", "Claude 3 Opus", anything typed by hand
// into the database before this list existed) resolve to the default so
// existing agents keep working.

export type ModelProvider = "openai" | "anthropic";

/**
 * The ids the picker offers and `workspaces.default_model` accepts, in the
 * order the interface shows them: cheapest-per-family last, so the two
 * flagships stay at the top where an unchanged install still finds them.
 *
 * A tuple rather than an array because `routes/workspace.ts` builds a
 * `z.enum()` out of it — widening it to `string[]` would quietly stop
 * validating what gets written to the database.
 */
export const MODEL_IDS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export type ModelSpec = {
  provider: ModelProvider;
  /**
   * Whether the endpoint accepts a `temperature` other than its own default.
   *
   * The GPT-5 family reasons before it answers and rejects any temperature but
   * 1 with a 400 — not a warning, a failed request. Brainstorm mode is the only
   * thing that sets one (0.9, `lib/prompt.ts`), so without this flag picking
   * gpt-5-mini for a brainstorming agent would break that mode alone, on that
   * model alone, which is exactly the kind of bug nobody reproduces.
   */
  temperature: boolean;
  /**
   * Whether the model thinks before it answers, and bills that thinking against
   * the same ceiling as the answer.
   *
   * This is the difference between `max_completion_tokens` meaning "how long an
   * answer" and meaning "how long an answer plus however much deliberation the
   * model decided to do first". Measured on the persona drafter, whose ceiling
   * is 400: gpt-5 spent 1408 tokens thinking, gpt-5-mini 512, gpt-5-nano 1152.
   * All three therefore returned an empty string with `finish_reason: "length"`
   * — a successful HTTP 200 carrying no content, which every caller here reads
   * as "the model failed".
   *
   * `lib/completion.ts` is where this is paid for, in one of two ways depending
   * on whether the caller wants the thinking at all.
   */
  reasoning: boolean;
};

/**
 * Keyed by `ModelId` rather than typed as a plain record, so adding an id to
 * the tuple above without describing it here is a type error rather than a
 * model that reaches `lib/completion.ts` with no provider.
 */
const SPECS: Record<ModelId, ModelSpec> = {
  "gpt-4o": { provider: "openai", temperature: true, reasoning: false },
  "gpt-4o-mini": { provider: "openai", temperature: true, reasoning: false },
  "gpt-4.1": { provider: "openai", temperature: true, reasoning: false },
  "gpt-4.1-mini": { provider: "openai", temperature: true, reasoning: false },
  "gpt-5": { provider: "openai", temperature: false, reasoning: true },
  "gpt-5-mini": { provider: "openai", temperature: false, reasoning: true },
  "gpt-5-nano": { provider: "openai", temperature: false, reasoning: true },
  "claude-sonnet-4-6": { provider: "anthropic", temperature: true, reasoning: false },
  "claude-sonnet-4-5": { provider: "anthropic", temperature: true, reasoning: false },
  "claude-haiku-4-5": { provider: "anthropic", temperature: true, reasoning: false },
};

export const DEFAULT_MODEL = "gpt-4o";

/** The environment a model decision reads. A subset of `RoutineEnv`. */
export type ModelEnv = {
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
};

/** What this build knows about `model`, or undefined if it is not one of ours. */
export function modelSpec(model: string | null | undefined): ModelSpec | undefined {
  return model ? SPECS[model as ModelId] : undefined;
}

/**
 * Whether Claude models can be served at all.
 *
 * `ANTHROPIC_API_KEY` is optional and its absence is a supported configuration,
 * not a misconfiguration: Covan has always needed exactly one key to answer
 * anything, and that is still true. Without it the Claude ids simply are not
 * offered and never resolve — see `resolveModel` and `availableModels`.
 */
export function anthropicEnabled(env?: ModelEnv): boolean {
  return Boolean(env?.ANTHROPIC_API_KEY);
}

/**
 * Which provider will answer for `model`.
 *
 * Unknown ids are OpenAI's, not an error: under `OPENAI_BASE_URL` every id is
 * unknown to this list by design, and those requests go to the OpenAI-shaped
 * client that endpoint speaks.
 */
export function providerFor(model: string | null | undefined): ModelProvider {
  return modelSpec(model)?.provider ?? "openai";
}

/** Whether a temperature may be sent for `model`. Unknown ids: yes, as before. */
export function acceptsTemperature(model: string | null | undefined): boolean {
  return modelSpec(model)?.temperature ?? true;
}

/**
 * Whether `model` bills its own deliberation against the output ceiling.
 *
 * Unknown ids are treated as not reasoning, which is the safe answer rather
 * than the optimistic one: under `OPENAI_BASE_URL` every id is unknown, and
 * quietly tripling a self-hoster's token ceiling because we could not identify
 * their model would be a cost decision made on their behalf.
 */
export function reasonsBeforeAnswering(model: string | null | undefined): boolean {
  return modelSpec(model)?.reasoning ?? false;
}

/**
 * The ids this deployment can actually serve, for the picker to render.
 *
 * A list that offers Claude to an install with no Anthropic key is a list that
 * lies: the pick would be stored, `resolveModel` would drop it, and the agent
 * would answer on gpt-4o with nothing on screen saying so. So the answer
 * depends on the environment, and /me carries it to the frontend.
 */
export function availableModels(env?: ModelEnv): ModelId[] {
  const anthropic = anthropicEnabled(env);
  return MODEL_IDS.filter((id) => SPECS[id].provider === "openai" || anthropic);
}

/**
 * Which model a completion should ask for.
 *
 * Three rules, in this order:
 *
 * 1. A Claude pick wins when there is a key for it. It has to come first: an
 *    Anthropic model is not served over the OpenAI-compatible endpoint, so
 *    `OPENAI_MODEL` has no say in it.
 * 2. `OPENAI_MODEL` wins over everything else, per-agent picker included. The
 *    allowlist above is a list of OpenAI's names, so it only means anything
 *    while the requests go to OpenAI. An operator who sets `OPENAI_BASE_URL` is
 *    talking to a server whose catalogue we cannot know, and every agent's
 *    stored model would otherwise resolve to `gpt-4o` — a name that endpoint
 *    has never heard of.
 * 3. Otherwise: the stored model if this build knows it, else the default.
 *
 * The ordering is also what keeps a private deployment private. An operator
 * running everything through Ollama has no `ANTHROPIC_API_KEY`, so rule 1
 * cannot fire, the Claude ids are never offered, and a stored one falls through
 * to rule 2 — the conversation stays on their endpoint. Setting the key is the
 * act that opts a deployment into sending anything to Anthropic.
 */
export function resolveModel(model: string | null | undefined, env?: ModelEnv): string {
  const spec = modelSpec(model);
  if (spec?.provider === "anthropic" && anthropicEnabled(env)) return model as string;
  // A Claude pick with no key for it falls through from here rather than
  // failing: an unserveable pick is the default, not a lost answer. Nobody's
  // agent stops replying because a key was rotated out.
  if (env?.OPENAI_MODEL) return env.OPENAI_MODEL;
  if (spec?.provider === "openai") return model as string;
  return DEFAULT_MODEL;
}
