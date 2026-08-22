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

// Output tokens are the expensive half of a reply — 4x input on every model in
// models.ts — and measured production replies average ~800 output tokens on the
// flagship agents. Much of that is preamble, restatement of the question and a
// closing recap rather than answer, so this names those three specifically
// instead of asking vaguely for brevity, which models tend to read as "write
// the same thing with shorter words".
//
// A default rather than a ceiling: it yields the moment the user asks for
// depth, so it trims habitual padding without making the agent unhelpful.
// `maxTokensFor` remains the hard stop; this is the one that changes the
// typical reply.
//
// Normal mode only — brainstorm deliberately wants 5-10 ideas plus critique and
// already carries its own "short, scannable lists over long prose" line.
//
// Lives in the system prefix, which is byte-identical turn over turn and so
// rides in OpenAI's automatic prompt cache: it costs its ~60 tokens once per
// cache window, not once per turn.
export const CONCISION_INSTRUCTIONS = [
  "Answer in as few words as the question genuinely needs.",
  "Open with the answer — no preamble, and do not restate the question back.",
  "Do not close with a summary of what you just said.",
  "Length should track the question: a one-line question gets a one-line answer.",
  "Expand freely when the user asks for detail, or when the subject genuinely requires it — brevity must never cost accuracy or omit a caveat that matters.",
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
  } else {
    prefix += `\n\n${CONCISION_INSTRUCTIONS}`;
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
