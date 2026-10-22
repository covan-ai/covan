// Shared agent metadata — the single source of truth for the model pickers:
// the models, the three tiers, what a message costs and what a model accepts.

/**
 * Every model this build knows, in picker order.
 *
 * This is the fallback, not the source of truth. Which of these a deployment
 * can actually serve depends on which provider keys it has — the Claude ids
 * need an `ANTHROPIC_API_KEY` the frontend cannot see — so the real list comes
 * from `/me` as `me.models`, and `modelsFor` below is what every picker calls.
 * The constant stays because a picker rendered before /me resolves still has to
 * render something, and because the self-hosted default (OpenAI only) is the
 * safe thing to show while waiting.
 */
export const MODELS = [
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

/**
 * Where the model picker starts for a new agent, when the workspace has named
 * no preference of its own.
 *
 * This used to be `MODELS[0]`, which is `gpt-4o`, and that coupling was the
 * whole problem: the tuple is ordered for *reading* — flagships first, so an
 * unchanged install finds them — and the first item of a display order is not
 * a statement about what anybody should be spending. Nothing said so, so the
 * most expensive model in the list was the default by accident.
 *
 * And it is the default that decides, because most people accept it. The model
 * it seeds is written to the agent row explicitly, so those agents are not
 * "on the default" in any way a later change could reach — they are on
 * `gpt-4o`, by name, forever. Which is also why this only affects agents made
 * from here on, and why nothing retroactively moves an agent somebody is
 * already talking to.
 *
 * `gpt-4.1-mini` rather than something cheaper still: it is roughly a sixth of
 * `gpt-4o` and newer, it **accepts a temperature** — `gpt-5-mini` does not, and
 * would have made the per-agent temperature setting inert on every new agent —
 * and it does not bill thinking against the answer's ceiling. Cheaper is
 * available (`gpt-4o-mini`) and one Select away for anyone who wants it.
 *
 * Since the picker grew tiers this is the *fallback*, not the usual answer:
 * `startingModelFor` seeds the Standard tier wherever the install serves it,
 * and lands here on an install without an Anthropic key — which is why this
 * must stay an OpenAI id, and why `agent-meta.test.ts` pins that.
 */
export const DEFAULT_NEW_AGENT_MODEL = "gpt-4.1-mini";

/**
 * The three choices a person who does not know the model names is offered.
 *
 * Thirteen ids in a Select is a question most people cannot answer; a tester
 * who was not an engineer said as much. Three words they can — fast, standard,
 * best — each standing for one model this build is confident in, with the
 * full list a disclosure away for anyone who wants an id.
 *
 * The descriptions say what each tier is for, in the words of the agent's
 * Configuration page; the price beside them comes from the server. Absolute, like `COST_BANDS`:
 * adding a model to the catalogue moves none of these.
 *
 * One provider for all three on purpose. Mixing providers across tiers would
 * mean tool use, thinking and web search behaving differently between "fast"
 * and "standard" for reasons the words do not explain.
 */
export const MODEL_TIERS = [
  {
    id: "fast",
    label: "Fast",
    description: "Short answers, simple lookups.",
    model: "claude-haiku-4-5",
  },
  {
    id: "standard",
    label: "Standard",
    description: "Reads documents, drafts replies, follows multi-step instructions.",
    model: "claude-sonnet-5",
  },
  {
    id: "best",
    label: "Best",
    description: "Long research, careful writing, browser work.",
    model: "claude-opus-5",
  },
] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * The tiers a picker can offer: those whose model is in `models` — what the
 * picker already lists, so an agent sitting on a tier model the install no
 * longer serves still shows its tier, carried in the way `modelsFor` carries
 * the id. Empty on an OpenAI-only install, where the picker stays a list.
 */
export function modelTiers(models: readonly string[]): ModelTier[] {
  return MODEL_TIERS.filter((t) => models.includes(t.model));
}

/** The tier a model id stands for, or null for one that is no tier. */
export function tierOf(model: string | null | undefined): ModelTier | null {
  return MODEL_TIERS.find((t) => t.model === model) ?? null;
}

/** What a chip or a sentence calls a model: its tier's word, else its id. */
export function modelLabel(model: string): string {
  return tierOf(model)?.label ?? model;
}

/**
 * Where a new agent starts: the workspace's own default when it has named
 * one, else the Standard tier wherever this install serves it, else
 * `DEFAULT_NEW_AGENT_MODEL`. Standard rather than Fast because most people
 * accept the default, and the default decides what the product feels like;
 * the cheaper tier is one press away.
 */
export function startingModelFor(
  available: readonly string[] | undefined,
  workspaceDefault: string | null | undefined,
): string {
  if (workspaceDefault) return workspaceDefault;
  const standard = MODEL_TIERS[1].model;
  return available?.includes(standard) ? standard : DEFAULT_NEW_AGENT_MODEL;
}

/**
 * What a model picker should list: what this install offers, plus whatever the
 * thing being edited is already on.
 *
 * The second half matters more than it looks. An agent can be sitting on a
 * model the deployment has stopped offering — a Claude one after the key was
 * rotated out, or an id dropped from a later build. A `<Select>` whose value
 * matches no item renders blank, so the settings page would show an agent with
 * no model at all and save whatever was picked next. Carrying the current value
 * in keeps it visible and leaves changing it a decision.
 */
export function modelsFor(available: string[] | undefined, current?: string | null): string[] {
  const offered = available && available.length > 0 ? available : DEFAULT_PICKER_MODELS;
  const list = [...offered];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

/**
 * What a picker shows before /me has answered — the OpenAI ids alone, because
 * those are the ones every deployment has by definition. Showing the Claude ids
 * on a hunch and removing them a moment later is worse than showing fewer.
 */
const DEFAULT_PICKER_MODELS = MODELS.filter((m) => !m.startsWith("claude-"));

/**
 * How hard a reasoning model is asked to think, cheapest first. Mirrors
 * `REASONING_EFFORTS` in `worker/src/lib/models.ts`, which is what the API
 * validates against and what migration 0048 constrains the column to.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** What each effort buys, for the one line of help under the picker. */
export const REASONING_EFFORT_HINTS: Record<ReasoningEffort, string> = {
  minimal: "Answers immediately. Cheapest, and best for lookups and rewrites.",
  low: "A moment's thought before answering.",
  medium: "The model's usual amount of deliberation.",
  high: "Thinks at length first. Best for analysis, and the most expensive.",
};

export type ModelSpec = { temperature: boolean; reasoning: boolean; webSearch: boolean };

/**
 * The three levels the composer's Thinking menu offers once thinking is on.
 *
 * Three of the four efforts, and the missing one is not an omission. A
 * conversation stores ONE value for both of its controls — Thinking and how
 * hard — because the server has one column and one knob, and `"minimal"` is
 * what that knob calls "do not deliberate" (`lib/completion.ts`). So the menu
 * spells `"minimal"` as Thinking Off, and these are what is left to call On.
 * The hints are the agent settings' own sentences, so the same level is not
 * described two ways in two places.
 */
export const DIAL_EFFORTS = ["low", "medium", "high"] as const;

export type DialEffort = (typeof DIAL_EFFORTS)[number];

export const DIAL_EFFORT_HINTS: Record<DialEffort, string> = {
  low: REASONING_EFFORT_HINTS.low,
  medium: REASONING_EFFORT_HINTS.medium,
  high: REASONING_EFFORT_HINTS.high,
};

/**
 * Which way the Thinking control reads for a stored effort.
 *
 * `"auto"` for null, and null is a choice rather than a gap: it is "whatever
 * the agent is set to", which is what every conversation did before it could
 * say otherwise. Collapsing it into Off or Medium would make the person's
 * not-having-chosen look like a choice they made.
 */
export function thinkingOf(effort: ReasoningEffort | null | undefined): "auto" | "off" | "on" {
  if (effort == null) return "auto";
  return effort === "minimal" ? "off" : "on";
}

/** The level Thinking is on at, or null when it is off or not chosen. */
export function effortLevelOf(effort: ReasoningEffort | null | undefined): DialEffort | null {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : null;
}

/**
 * The word the Thinking chip and the agent's Configuration use for an effort:
 * Off, Brief, Standard, Extended. The stored values stay the API's
 * (`minimal`…`high`); only what a person reads changes.
 */
export const EFFORT_WORDS: Record<ReasoningEffort, string> = {
  minimal: "Off",
  low: "Brief",
  medium: "Standard",
  high: "Extended",
};

/** "medium" → "Standard", for a chip and a sentence. */
export function effortWord(effort: ReasoningEffort): string {
  return EFFORT_WORDS[effort];
}

/**
 * What a conversation is answered with, in the few words a chip has room for:
 * `Best · Standard`, or `gpt-4.1` alone — the tier's word where the model
 * is a tier (`modelLabel`), the id where it is not.
 *
 * The effort is dropped on a model that does not reason, and not because it
 * would be untidy: the worker ignores an effort it cannot send, so printing
 * one there would describe a setting that is doing nothing — a claim the code
 * cannot back, which is DESIGN.md's first failure mode. Dropped too when there
 * is no effort at all, where the model's own default is the honest reading
 * and a word for it would be a guess.
 */
export function dialLabel(
  model: string,
  effort: ReasoningEffort | null | undefined,
  reasons: boolean,
): string {
  const name = modelLabel(model);
  if (!reasons || effort == null) return name;
  return `${name} · ${effortWord(effort)}`;
}

/**
 * What a model costs per reply, as the server priced it, or `null`.
 *
 * `null` is a real answer with two causes, and neither is a gap to fill in with
 * a guess: the id is one this build has no price for (every id is, under a
 * custom endpoint), or the deployment has `OPENAI_MODEL` set and the picked id
 * is not what answers at all. `lib/pricing.ts` on the server decides both.
 */
export function costFor(
  costs: Record<string, number> | undefined,
  model: string | null | undefined,
): number | null {
  const found = model ? costs?.[model] : undefined;
  return typeof found === "number" ? found : null;
}

/**
 * The bands the scale under a model picker is divided into.
 *
 * **Absolute, and that is the design decision.** Bands drawn as percentiles of
 * the catalogue, or relative to its cheapest member, would move a model between
 * tiers because a *different* model was added — the same pick, the same price,
 * a different claim about it. That is DESIGN.md's first failure mode: something
 * the code cannot stand behind. These boundaries are money, so adding a model
 * moves nothing.
 *
 * Half a cent and one and a half cents are round numbers near two real ones:
 * the mini models land under the first and the flagships above the second, with
 * the middle band holding what 0025 actually measured.
 */
export const COST_BANDS = [
  { upToUsd: 0.005, label: "under ½¢" },
  { upToUsd: 0.015, label: "½¢–1½¢" },
  { upToUsd: Infinity, label: "over 1½¢" },
] as const;

/** Which band `cost` falls in, or -1 when there is no price to place. */
export function costBandIndex(cost: number | null): number {
  if (cost === null) return -1;
  return COST_BANDS.findIndex((b) => cost < b.upToUsd);
}

/**
 * A price a person can read at a glance.
 *
 * Three decimals once there are cents to show, four below that — `$0.00` for
 * gpt-5-nano would round the cheapest model in the catalogue to free, which is
 * the one number on this scale worth getting right.
 */
export function formatReplyCost(cost: number): string {
  return cost >= 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(4)}`;
}

/**
 * The per-model reply prices a picker shows, in the one unit this deployment
 * answers in.
 *
 * Credits on the hosted service, where `/me` sends `modelCredits`; dollars on
 * an install that has no credits, where it sends `modelCosts` alone. The unit
 * travels with the figures so that no screen ever converts — the rate is the
 * hosted build's, and the open tree does not have it.
 */
export type ReplyPriceUnit = "credits" | "usd";
export type ReplyPrices = { unit: ReplyPriceUnit; byModel: Record<string, number> };
export type ReplyPrice = { unit: ReplyPriceUnit; amount: number };

/** Credits when the server sent them, else dollars, else nothing. */
export function replyPricesOf(
  me:
    | { modelCosts?: Record<string, number>; modelCredits?: Record<string, number> }
    | null
    | undefined,
): ReplyPrices | undefined {
  if (!me) return undefined;
  if (me.modelCredits) return { unit: "credits", byModel: me.modelCredits };
  if (me.modelCosts) return { unit: "usd", byModel: me.modelCosts };
  return undefined;
}

/** `costFor`, carrying the unit. Null for an id with no price. */
export function priceFor(
  prices: ReplyPrices | undefined,
  model: string | null | undefined,
): ReplyPrice | null {
  const amount = costFor(prices?.byModel, model);
  return prices && amount !== null ? { unit: prices.unit, amount } : null;
}

/**
 * "~14 credits", "~270 credits", "~1 credit", "<1 credit".
 *
 * Whole credits under twenty and two figures above, the way `approximateReplies`
 * rounds replies: a per-reply price to three decimals would claim a precision
 * the reference reply does not have. Its own rounding rather than that
 * function's, because `credits.ts` reaches `api-client` at import and this
 * module is meant to stay free of it.
 */
export function formatReplyCredits(credits: number): string {
  if (credits < 1) return "<1 credit";
  let rounded: number;
  if (credits < 20) rounded = Math.round(credits);
  else {
    const magnitude = 10 ** (Math.floor(Math.log10(credits)) - 1);
    rounded = Math.round(credits / magnitude) * magnitude;
  }
  return `~${rounded.toLocaleString()} ${rounded === 1 ? "credit" : "credits"}`;
}

/** A reply price in its own unit. */
export function formatReplyPrice(price: ReplyPrice): string {
  return price.unit === "credits"
    ? formatReplyCredits(price.amount)
    : formatReplyCost(price.amount);
}

/**
 * What a model will accept, as the server described it.
 *
 * The fallback matters more than the lookup. `modelSpecs` arrives with /me and
 * covers the ids this deployment serves; an agent can be sitting on one it does
 * not — a Claude pick after the key was rotated out, or anything at all under a
 * custom endpoint, where every id is unknown by design. The answer for those is
 * the server's own answer for an unknown id (`lib/models.ts`): a temperature is
 * accepted, and the model does not reason. Optimistic about the control that is
 * harmless to offer and conservative about the ones that are not. It cannot
 * search either: an id the server does not serve is answered by the
 * OpenAI-compatible endpoint, and nothing sends a search tool there.
 */
export function specFor(
  specs: Record<string, ModelSpec> | undefined,
  model: string | null | undefined,
): ModelSpec {
  const known = model ? specs?.[model] : undefined;
  return known ?? { temperature: true, reasoning: false, webSearch: false };
}

// A per-model colour used to live here — emerald for GPT, violet for Llama and
// so on. The design system allows exactly one saturated colour, so a palette
// keyed on model name is off-system by construction: models are now
// distinguished by their name in a monospace code chip (§7.8), which is also
// more legible than a colour nobody has learned.
