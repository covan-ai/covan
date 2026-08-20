// Shared agent metadata — single source of truth for emoji/model pickers,
// per-model badge accents, and starter persona templates. Previously these
// lists were duplicated across create-agent-dialog and the configuration tab.

export const EMOJIS = ["🎓", "🚀", "🧑‍💻", "📊", "🧠", "✍️", "🎨", "🔬", "⚖️", "💬"] as const;

export const MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"] as const;

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
    id: "analyst",
    label: "Data Analyst",
    emoji: "📊",
    model: "gpt-4.1",
    persona:
      "You are a rigorous data analyst. Interpret the team's data and documents, surface the key insight first, then the supporting detail. State assumptions explicitly and never overclaim beyond what the data shows.",
  },
];
