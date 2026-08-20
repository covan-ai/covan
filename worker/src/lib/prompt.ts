export const DEFAULT_PERSONA = "You are a helpful AI assistant for a team workspace.";

// Layered on top of the persona when an agent is in brainstorm mode. Sequences
// the four facilitation behaviors so they cooperate instead of contradicting:
// understand -> diverge -> pressure-test -> (frameworks throughout) -> hand back.
export const BRAINSTORM_INSTRUCTIONS = [
  "You are now in BRAINSTORM MODE. Your job is to facilitate idea generation, not to close on a single answer.",
  "Follow this flow:",
  "1. Understand first: before proposing anything, ask 1-2 sharp questions to surface the user's real intent and constraints. If they clearly just want ideas now, keep this to one quick question or skip it.",
  "2. Diverge: generate many varied ideas (aim for 5-10 distinct angles), including unconventional ones. Withhold judgment while generating - quantity and range over polish.",
  "3. Pressure-test: then put on a devil's advocate hat. For the strongest ideas, name the weak point, the risk, and the hidden assumption each one rests on.",
  "4. Use frameworks as tools where they fit: SCAMPER, reverse-it (what would guarantee failure?), 'worst possible idea', or Crazy 8s.",
  "5. Close by handing back: end your turn by asking which direction to go deeper on.",
  "Tone: energetic and non-judgmental while generating; sharp and honest while critiquing. Prefer short, scannable lists over long prose.",
].join("\n");

const MANIFEST = (names: string) =>
  `\n\nYou have access to the following team documents: ${names}. ` +
  `When the user refers to "the file", "the document", "the video", or asks you to ` +
  `summarize or explain what was uploaded, use the shared knowledge provided below — ` +
  `never claim you cannot read files.`;

export function buildSystemPrefix(input: {
  persona: string | null;
  mode: "normal" | "brainstorm";
  docNames: string[];
}): string {
  const persona =
    input.persona && input.persona.trim().length > 0 ? input.persona : DEFAULT_PERSONA;

  let prefix = persona;
  if (input.mode === "brainstorm") {
    prefix += `\n\n${BRAINSTORM_INSTRUCTIONS}`;
  }
  if (input.docNames.length > 0) {
    prefix += MANIFEST(input.docNames.join(", "));
  }
  return prefix;
}

export function temperatureFor(mode: "normal" | "brainstorm"): number | undefined {
  return mode === "brainstorm" ? 0.9 : undefined;
}

// Upper bound on generated tokens. Output tokens are the most expensive
// dimension (4x input on gpt-4o), so a cap protects against runaway replies
// without touching typical answers. Brainstorm needs more room for 5-10 ideas
// plus critique; normal chat replies rarely approach the lower cap. Tunable.
export function maxTokensFor(mode: "normal" | "brainstorm"): number {
  return mode === "brainstorm" ? 3072 : 1536;
}
