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
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

/**
 * How hard a reasoning model is asked to think before it writes, in the API's
 * own vocabulary, cheapest first.
 *
 * A tuple for the same reason `MODEL_IDS` is one: `routes/agents.ts` builds a
 * `z.enum()` out of it, and migration 0048 checks the same four strings in the
 * database. Three lists that have to agree, so this is the one they are all
 * spelled from.
 *
 * Absent is not a fifth value: an agent that names no effort gets whatever the
 * model does by default, which is what every agent got before this was
 * settable. Saying `"medium"` is a different request from saying nothing.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

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
   *
   * It is also what the settings screen reads to decide whether to offer the
   * effort picker at all, which is why the Claude models carry it. What they do
   * *not* share with the GPT-5 family is when the thinking happens: a GPT-5
   * model deliberates on every call, while a Claude model here only deliberates
   * when this build asks it to — see `thinksByDefault` below, and the headroom
   * branch in `lib/completion.ts` that follows from it.
   */
  reasoning: boolean;
  /**
   * Whether the model deliberates with nothing asked of it.
   *
   * Claude Opus 5 does: omitting the thinking parameter runs adaptive thinking
   * rather than none, which is the opposite of every other model on this list
   * and of Opus 4.8, its immediate predecessor. It matters here for one reason
   * — the output ceiling. A model that thinks unasked needs room for it on
   * every call, and a model that does not must not be handed that room, because
   * the room is not free: it is the number that decides how long a runaway
   * answer is allowed to get.
   *
   * Absent means "only when asked", which is the normal case.
   */
  thinksByDefault?: boolean;
  /**
   * Whether the model can be given tools and asked to call them.
   *
   * True for every id on this list, which makes it look like a field with one
   * value — and it is not, because the interesting answer is the one for an id
   * that is *not* on it. Under `OPENAI_BASE_URL` every id is unknown, and an
   * Ollama or vLLM build serving a model without function calling either
   * ignores the `tools` field or 400s on it. Neither is a failure anybody can
   * read: the first is an agent that quietly never uses a tool, the second is
   * a chat that stopped working the day tools shipped.
   *
   * So the harness asks `supportsTools` first and, when the answer is no, runs
   * the turn with no tools and says so — see `lib/harness/loop.ts`.
   */
  tools: boolean;
};

/**
 * Keyed by `ModelId` rather than typed as a plain record, so adding an id to
 * the tuple above without describing it here is a type error rather than a
 * model that reaches `lib/completion.ts` with no provider.
 */
const SPECS: Record<ModelId, ModelSpec> = {
  "gpt-4o": { provider: "openai", temperature: true, reasoning: false, tools: true },
  "gpt-4o-mini": { provider: "openai", temperature: true, reasoning: false, tools: true },
  "gpt-4.1": { provider: "openai", temperature: true, reasoning: false, tools: true },
  "gpt-4.1-mini": { provider: "openai", temperature: true, reasoning: false, tools: true },
  "gpt-5": { provider: "openai", temperature: false, reasoning: true, tools: true },
  "gpt-5-mini": { provider: "openai", temperature: false, reasoning: true, tools: true },
  "gpt-5-nano": { provider: "openai", temperature: false, reasoning: true, tools: true },
  // `temperature: false` on the three newest Claude models is not a style
  // choice mirroring the GPT-5 rows above it — the parameter was removed from
  // those endpoints and sending one is a 400, exactly as it is on GPT-5. The
  // 4.6 and 4.5 models still take it, which is why they still say true.
  //
  // `reasoning: true` from Sonnet 4.6 onward: all four take adaptive thinking
  // and an effort. The two 4.5 models do not — an effort on those is a 400 —
  // so they stay false and their agents keep getting the model's own default.
  "claude-opus-5": {
    provider: "anthropic",
    temperature: false,
    reasoning: true,
    tools: true,
    thinksByDefault: true,
  },
  "claude-sonnet-5": { provider: "anthropic", temperature: false, reasoning: true, tools: true },
  "claude-opus-4-8": { provider: "anthropic", temperature: false, reasoning: true, tools: true },
  "claude-sonnet-4-6": { provider: "anthropic", temperature: true, reasoning: true, tools: true },
  "claude-sonnet-4-5": { provider: "anthropic", temperature: true, reasoning: false, tools: true },
  "claude-haiku-4-5": { provider: "anthropic", temperature: true, reasoning: false, tools: true },
};

/**
 * What an agent runs on when nothing else decides.
 *
 * Moved off `gpt-4o`, which had been the default since before this file knew
 * about a second provider. `gpt-4.1` is the same tier and the same shape of
 * model — it takes a temperature, it does not deliberate first — so no agent
 * changes behaviour by landing here, and it is cheaper per token in both
 * directions. That is the whole of the reasoning: a strictly better version of
 * the same choice, not a new one.
 *
 * Deliberately *not* one of the mini models. This is the fallback for an agent
 * whose stored model this build does not recognise, which includes every agent
 * created before the picker existed. Making those quietly cheaper is a decision
 * about somebody else's answers, and it is not ours to make silently.
 */
export const DEFAULT_MODEL = "gpt-4.1";

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
 * Whether `model` deliberates without being asked to.
 *
 * Unknown ids: no. Same reasoning as `reasonsBeforeAnswering` above — under
 * `OPENAI_BASE_URL` every id is unknown, and the optimistic answer would widen
 * a self-hoster's ceiling on every call because we could not identify their
 * model.
 */
export function thinksByDefault(model: string | null | undefined): boolean {
  return modelSpec(model)?.thinksByDefault ?? false;
}

/**
 * Whether `model` can be handed tools.
 *
 * Unknown ids: no, on the same principle as `reasonsBeforeAnswering` above —
 * the safe answer rather than the optimistic one. An operator pointing
 * `OPENAI_BASE_URL` at their own server gets an agent that answers without
 * tools and says why, instead of one that 400s on every turn.
 */
export function supportsTools(model: string | null | undefined): boolean {
  return modelSpec(model)?.tools ?? false;
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
/**
 * What each of `ids` accepts, for the agent settings screen to render against.
 *
 * `SPECS` stays private — `provider` is a routing decision and nothing outside
 * this file has any business reading it — so this projects the two fields a
 * picker needs and no more.
 */
export function modelSpecsFor(
  ids: readonly string[],
): Record<string, { temperature: boolean; reasoning: boolean }> {
  const out: Record<string, { temperature: boolean; reasoning: boolean }> = {};
  for (const id of ids) {
    const spec = modelSpec(id);
    if (spec) out[id] = { temperature: spec.temperature, reasoning: spec.reasoning };
  }
  return out;
}

/**
 * The cheapest model of the same provider, for work that is shaping rather than
 * thinking.
 *
 * Naming a conversation is five words long and reads one message. It was being
 * asked of whatever the agent runs on, so a `claude-sonnet-4-6` agent paid
 * flagship input *and* output rates to write "Invoice numbering question", once
 * per new chat, forever. Nothing about the title got better for it:
 * `session-title.ts` already caps the reply at 64 tokens, already asks for
 * minimal effort, and already treats every failure as "keep the name you had".
 *
 * The same is true of the other two shaping callers — the persona drafter and
 * the idea extractor — but those are one-off actions somebody pressed a button
 * for. Titling is the one that fires on its own, on every new session, on the
 * hot path of the product's main screen, which is what makes it worth a rule.
 *
 * **Same provider, never across.** Swapping a Claude agent onto an OpenAI id
 * would send that user's first message to a provider their workspace may have
 * deliberately not enabled, and would fail outright where only one key is set.
 *
 * **An id this build does not know keeps its own model**, and so does any
 * deployment with `OPENAI_MODEL` set. Under `OPENAI_BASE_URL` the catalogue
 * belongs to somebody else's server: `gpt-4o-mini` is a name it has probably
 * never heard of, and a 404 would turn a free convenience into a broken one.
 * Same reasoning as rule 2 of `resolveModel`, and the same direction — when in
 * doubt, do what the operator configured.
 */
export function titleModelFor(model: string, env?: ModelEnv): string {
  if (env?.OPENAI_MODEL) return model;
  const spec = modelSpec(model);
  if (!spec) return model;
  if (spec.provider === "anthropic") return "claude-haiku-4-5";
  return "gpt-4o-mini";
}

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
