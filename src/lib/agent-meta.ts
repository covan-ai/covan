// Shared agent metadata — single source of truth for emoji/model pickers,
// per-model badge accents, and starter persona templates. Previously these
// lists were duplicated across create-agent-dialog and the configuration tab.

// Every emoji a template uses has to be on this list, and not for tidiness: the
// create dialog and the agent settings tab both render it as the option set of
// a `Select`. A template carrying an emoji that is not here pre-fills a value
// with no matching item, so the picker shows a blank — on the new agent, and
// again every time somebody opens its settings afterwards.
// `agent-meta.test.ts` pins that.
export const EMOJIS = ["🎓", "🚀", "🧑‍💻", "📊", "🧠", "✍️", "🎨", "🔬", "⚖️", "💬", "🧭"] as const;

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
 */
export const DEFAULT_NEW_AGENT_MODEL = "gpt-4.1-mini";

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

/** "medium" → "Medium", for a chip and a sentence. */
export function effortWord(effort: ReasoningEffort): string {
  return effort === "minimal" ? "Thinking off" : effort[0].toUpperCase() + effort.slice(1);
}

/**
 * What a conversation is answered with, in the few words a chip has room for:
 * `claude-opus-5 · Medium`, or `gpt-4.1` alone.
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
  if (!reasons || effort == null) return model;
  return `${model} · ${effortWord(effort)}`;
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

export type PersonaTemplate = {
  id: string;
  label: string;
  emoji: string;
  model: string;
  persona: string;
};

// Starter templates surfaced in the create dialog. Picking one pre-fills the
// icon, model, and persona so a new agent can be created in seconds.
//
// A persona that grounds the agent says "documents and connected apps", never
// the knowledge base alone. The model takes the narrower reading literally: a
// Knowledge Tutor told to stay "inside the knowledge base" answered "look at
// my Notion page" with two document searches and "I cannot see Notion", with
// Notion connected and named in its prompt. A persona is copied into the agent
// when it is created, so this changes new agents only.
export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "support",
    label: "Support Agent",
    emoji: "💬",
    model: "gpt-4o-mini",
    persona:
      "You are a friendly, patient customer support specialist. Answer using only the team's knowledge base and the apps it has connected. Be concise, confirm you understood the issue, and give clear step-by-step help. If you don't know, say so and offer to escalate.",
  },
  {
    id: "coding",
    label: "Coding Assistant",
    emoji: "🧑‍💻",
    model: "gpt-4.1-mini",
    persona:
      "You are a senior software engineer. Give correct, idiomatic code that matches the team's existing conventions. Explain trade-offs briefly, prefer small focused changes, and point out edge cases. Reference the team's docs when relevant.",
  },
  {
    id: "gtm",
    label: "GTM Strategist",
    emoji: "🚀",
    model: "gpt-4.1-mini",
    persona:
      "You are a go-to-market strategist. Help the team with positioning, messaging, and launch planning grounded in our product docs. Be sharp and specific, avoid generic marketing fluff, and always tie advice back to the target customer.",
  },
  {
    id: "tutor",
    label: "Knowledge Tutor",
    emoji: "🎓",
    model: "gpt-4.1-mini",
    persona:
      "You are a patient tutor. Explain concepts from the team's documents and connected apps clearly, adapting to the learner's level. Use examples and analogies, check understanding with a short question, and never invent facts beyond what those sources say.",
  },
  {
    id: "writer",
    label: "Content Writer",
    emoji: "✍️",
    model: "gpt-4.1-mini",
    persona:
      "You are a skilled content writer who matches the team's brand voice. Draft clear, engaging copy grounded in our docs. Offer a couple of variations when useful, keep it tight, and flag anything that needs a fact-check.",
  },
  {
    // The week somebody joins is the clearest first job a team has for
    // something that has read everything: the same questions get asked out
    // loud, and the cost of nobody having written things down is visible that
    // week and invisible every other one (covan#45).
    //
    // `gpt-4o-mini` on purpose, and it is the only template below the top tier
    // besides Support. A new joiner asks many small questions whose answers are
    // already in the documents; the work is retrieval and plain phrasing, not
    // reasoning, and the cheaper model is the one that survives a busy first
    // week without the cost being noticed.
    //
    // The persona's second half is the part that matters. An onboarding agent
    // that fills a gap with a plausible answer is worse than no agent at all,
    // because the person asking has no way to know it is wrong and every reason
    // to repeat it.
    id: "onboarding",
    label: "Onboarding Guide",
    emoji: "🧭",
    model: "gpt-4o-mini",
    persona:
      "You are the colleague a new joiner can ask anything, however small. Answer from the team's own documents and connected apps rather than from general knowledge — how this team does it, not how it is usually done. Keep replies short and point to the next thing worth reading. If they do not cover something, say so plainly and suggest who to ask; never fill the gap with a plausible answer.",
  },
  {
    id: "analyst",
    label: "Data Analyst",
    emoji: "📊",
    model: "gpt-4.1",
    persona:
      "You are a rigorous data analyst. Interpret the team's data and documents, surface the key insight first, then the supporting detail. State assumptions explicitly and never overclaim beyond what the data shows.",
  },
];
