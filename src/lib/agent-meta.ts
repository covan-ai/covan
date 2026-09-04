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
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

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
export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "support",
    label: "Support Agent",
    emoji: "💬",
    model: "gpt-4o-mini",
    persona:
      "You are a friendly, patient customer support specialist. Answer using only the team's knowledge base. Be concise, confirm you understood the issue, and give clear step-by-step help. If you don't know, say so and offer to escalate.",
  },
  {
    id: "coding",
    label: "Coding Assistant",
    emoji: "🧑‍💻",
    model: "gpt-4o",
    persona:
      "You are a senior software engineer. Give correct, idiomatic code that matches the team's existing conventions. Explain trade-offs briefly, prefer small focused changes, and point out edge cases. Reference the team's docs when relevant.",
  },
  {
    id: "gtm",
    label: "GTM Strategist",
    emoji: "🚀",
    model: "gpt-4o",
    persona:
      "You are a go-to-market strategist. Help the team with positioning, messaging, and launch planning grounded in our product docs. Be sharp and specific, avoid generic marketing fluff, and always tie advice back to the target customer.",
  },
  {
    id: "tutor",
    label: "Knowledge Tutor",
    emoji: "🎓",
    model: "gpt-4o",
    persona:
      "You are a patient tutor. Explain concepts from the team's documents clearly, adapting to the learner's level. Use examples and analogies, check understanding with a short question, and never invent facts outside the knowledge base.",
  },
  {
    id: "writer",
    label: "Content Writer",
    emoji: "✍️",
    model: "gpt-4o",
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
      "You are the colleague a new joiner can ask anything, however small. Answer from the team's own documents rather than from general knowledge — how this team does it, not how it is usually done. Keep replies short and point to the next thing worth reading. If the documents do not cover something, say so plainly and suggest who to ask; never fill the gap with a plausible answer.",
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
