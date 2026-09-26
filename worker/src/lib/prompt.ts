import { REASONING_EFFORTS, type ReasoningEffort } from "./models";

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

// Shapes the typical reply without capping it. The goal is to prevent habitual
// padding (preamble, restated question, closing recap) while letting the model
// write as much as the question genuinely needs — a one-sentence answer for a
// factual lookup, a structured walkthrough for a design question.
//
// Normal mode only — brainstorm deliberately wants 5-10 ideas plus critique and
// already carries its own "short, scannable lists over long prose" line.
//
// Lives in the system prefix, which is byte-identical turn over turn and so
// rides in OpenAI's automatic prompt cache: it costs its ~60 tokens once per
// cache window, not once per turn.
export const CONCISION_INSTRUCTIONS = [
  "Match your response length to what the question needs — a simple question gets a direct answer, a complex question gets a thorough one.",
  "Open with the answer, not with a restatement of the question.",
  "Do not close by summarizing what you just said.",
  "Use structure (headings, lists, code blocks) when it helps readability.",
  "Be conversational and clear. Never terse for terseness' sake.",
].join("\n");

/**
 * What a report is, said to a model that has spent every other turn being told
 * to be brief.
 *
 * `CONCISION_INSTRUCTIONS` above is the right instruction for a chat turn and
 * exactly the wrong one here — a report is asked for precisely when the short
 * answer is not the deliverable. So this replaces it rather than layering on
 * top of it, which is why report is a mode and not a flag.
 *
 * The title line is load-bearing: `lib/report.ts` reads it to name the document,
 * and a report that opens with "Here is the report you asked for" is filed under
 * a date instead of under its own subject.
 */
export const REPORT_INSTRUCTIONS = [
  "Write a document, not a chat reply. The reader will open this on its own, without the conversation around it.",
  "Open with a single `# ` title on the first line, naming the subject. No preamble above it.",
  "Structure the body with `## ` sections. Use prose; reach for a list or a table only where one genuinely reads better.",
  "Ground every claim in the documents and the conversation you were given. Attribute anything specific to the document it came from.",
  "Where the sources do not answer something the report needs, say so in the report and name what is missing. Never fill the gap with a plausible number or date.",
  "Do not close by summarising what you just wrote.",
].join("\n");

/**
 * How many filenames the manifest names before it starts counting instead.
 *
 * The manifest rides in the cacheable prefix, so its cost is amortised rather
 * than per-turn — but a workspace with three hundred documents would still push
 * the model's context out with a list nobody reads. Forty names is enough for
 * the manifest's actual job: letting the agent recognise a file when the user
 * names one.
 */
export const MANIFEST_NAME_LIMIT = 40;

/**
 * The line that tells the agent which files it has.
 *
 * The wording matters more than it looks. This sits in the *cacheable* prefix,
 * which is byte-identical on every turn — including the turns where retrieval
 * found nothing and no excerpt block follows it. The previous version pointed
 * at "the shared knowledge provided below" unconditionally, so on those turns
 * it named a document, promised its contents were attached, attached nothing,
 * and left the model to fill the gap. Saying that excerpts arrive *when
 * retrieval finds them* is true on both kinds of turn, and gives the model
 * somewhere honest to go when they don't.
 *
 * The clause about preferring the excerpt and admitting when it falls short is
 * here rather than in the excerpt block for the same reason everything else in
 * this prefix is: the block is rebuilt every turn and never caches, so an
 * instruction living in it is bought again on every question. This one is
 * bought once per cache window and applies to every turn of the chat.
 */
const MANIFEST = (names: string) =>
  `\n\nThe team has shared these documents with you: ${names}. ` +
  `When the user says "the file", "the document", "the video", or asks what was ` +
  `uploaded, they mean one of these — never claim you cannot read files. ` +
  `Relevant excerpts are supplied in a separate system message whenever retrieval ` +
  `finds them; answer from those in preference to what you already believe, and ` +
  `say plainly when they do not cover what was asked rather than filling the gap. ` +
  `If no excerpt is present, say which of these ` +
  `documents you would need to look at rather than inventing what it contains.`;

function manifestNames(names: string[]): string {
  if (names.length <= MANIFEST_NAME_LIMIT) return names.join(", ");
  const shown = names.slice(0, MANIFEST_NAME_LIMIT).join(", ");
  const rest = names.length - MANIFEST_NAME_LIMIT;
  return `${shown}, and ${rest} more`;
}

/**
 * What shape of output a turn is asking for. "normal" and "brainstorm" are
 * session modes a conversation sits in (`lib/session-mode.ts`); "report" is not
 * — it is the shape of one call, and a session never enters it.
 */
export type PromptMode = "normal" | "brainstorm" | "report";

/**
 * Core capabilities that apply regardless of mode or documents.
 *
 * Lives in the system prefix, which is byte-identical turn over turn and rides
 * in the prompt cache. Updated when capabilities change (web search, code
 * execution, etc).
 */
const CAPABILITIES = [
  "You can search the web when needed — use it for real-time information, current events, external data, or anything beyond the team's documents.",
  "You can read and analyze all file types the team uploads: PDFs, Word docs, spreadsheets, images, code files, and more.",
  "When working with code, you can explain, debug, refactor, or write new code across any language or framework.",
  "You have access to the team's full conversation history in this workspace.",
].join(" ");

/** Whether `Intl` recognises a zone, so an unknown one degrades instead of throwing. */
function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * When and where the agent is, in one line.
 *
 * Nothing on the chat path said either until #196. A request like "every Monday
 * until the end of October at 22:00" cannot be answered without both: which
 * Mondays needs the date, and what 22:00 means needs the zone. Production on
 * 2026-09-26 got them right by inferring them from the language of the request,
 * which is luck — an earlier request the same evening carried no date at all.
 *
 * The date and not the clock, deliberately. This prefix is byte-identical turn
 * over turn so that it rides the prompt cache; a time in it would miss on every
 * turn, where a date misses once a day.
 *
 * The zone is stated as the one times are *meant* in rather than as a fact about
 * the person, because that is the thing the agent has to act on — and because it
 * is a per-request guess, not a stored setting.
 */
function whenAndWhere(now: Date, timezone: string | null | undefined): string {
  const asked = timezone?.trim() ? timezone.trim() : "UTC";
  const zone = validZone(asked) ? asked : "UTC";
  const today = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: zone,
  });
  return (
    `Today is ${today}. Times mean ${zone} unless somebody says otherwise — read ` +
    `and write them in that zone, and say which zone you used when a time could be ` +
    `read two ways. When a tool takes a zone as its own argument, pass ${zone} ` +
    `rather than putting an offset in the timestamp.`
  );
}

export function buildSystemPrefix(input: {
  persona: string | null;
  mode: PromptMode;
  docNames: string[];
  webSearchEnabled?: boolean;
  /** Omitted rather than defaulted to `new Date()`: a prefix built without a
   * clock should say nothing about the date, not quietly guess UTC. */
  now?: Date;
  timezone?: string | null;
}): string {
  const persona =
    input.persona && input.persona.trim().length > 0 ? input.persona : DEFAULT_PERSONA;

  let prefix = persona;

  // Add capabilities (web search only if enabled)
  if (input.webSearchEnabled) {
    prefix += `\n\n${CAPABILITIES}`;
  }

  if (input.now) {
    prefix += `\n\n${whenAndWhere(input.now, input.timezone)}`;
  }

  if (input.mode === "brainstorm") {
    prefix += `\n\n${BRAINSTORM_INSTRUCTIONS}`;
  } else if (input.mode === "report") {
    prefix += `\n\n${REPORT_INSTRUCTIONS}`;
  } else {
    prefix += `\n\n${CONCISION_INSTRUCTIONS}`;
  }
  const names = input.docNames.filter((n) => n && n.trim().length > 0);
  if (names.length > 0) {
    prefix += MANIFEST(manifestNames(names));
  }
  return prefix;
}

/**
 * How much the model may vary its wording, and who decides.
 *
 * The agent's own setting wins when it has one (0048). Null — which is every
 * agent until somebody moves the dial — leaves the decision where it has always
 * been: brainstorm wants range and asks for 0.9, and normal chat sends nothing
 * at all, which is not the same as sending the provider's default value and is
 * the reason this returns `undefined` rather than a number.
 *
 * `0` is a legitimate setting and means "as close to the same answer every time
 * as this model gets", so the check is against null and not against falsiness.
 */
export function temperatureFor(mode: PromptMode, override?: number | null): number | undefined {
  if (override !== null && override !== undefined) return override;
  return mode === "brainstorm" ? 0.9 : undefined;
}

/**
 * How long the agent may think before it answers.
 *
 * There is no mode default here and deliberately no default of any kind:
 * `undefined` means the request carries no `reasoning_effort` and the model
 * does whatever it does, which is what every reply in this product has been
 * getting. See `REASONING_EFFORTS` in `lib/models.ts` for why "medium" is not
 * that.
 *
 * Unknown strings are dropped rather than forwarded. The database constrains
 * this column (0048) and the API validates it, so a value that is neither null
 * nor one of the four can only be a row written before those existed or by
 * something that bypassed both — and forwarding it would turn that into a 400
 * on every turn of a conversation.
 */
export function reasoningEffortFor(override?: string | null): ReasoningEffort | undefined {
  if (!override) return undefined;
  return (REASONING_EFFORTS as readonly string[]).includes(override)
    ? (override as ReasoningEffort)
    : undefined;
}

// Upper bound on generated tokens. Output tokens are the most expensive
// dimension (4x input on gpt-4o), so a cap protects against runaway replies
// without touching typical answers. 4096 for chat is a ceiling, not a target:
// the system prompt shapes typical length, and most replies land well below it.
// Reports get double because their length is the deliverable.
export function maxTokensFor(mode: PromptMode): number {
  // A report is the one output whose length is the point, and output tokens are
  // the expensive dimension — so this is the number that decides what a report
  // costs. 8192 is about sixteen pages of English and nearer eight of Turkish,
  // which needs more tokens for the same text.
  if (mode === "report") return 8192;
  return 4096;
}
