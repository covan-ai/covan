import { complete, totalTokens, type CompletionEnv } from "./completion";

/**
 * How wide a generated title may be. The sidebar truncates with an ellipsis
 * anyway, so anything past this is paid for and never read.
 */
export const TITLE_MAX_CHARS = 60;

/**
 * How much of the opening message is worth sending to be titled. A title comes
 * out of the first sentence or two; the rest of a pasted wall of text only adds
 * input tokens. Titling is charged against the same monthly allowance as the
 * reply, so this cap is a real saving and not a stylistic one.
 */
const SOURCE_MAX_CHARS = 1000;

/**
 * How long a titling call may take before it is abandoned.
 *
 * The turn waits on this before it closes, so the number is not about the title
 * — it is about the composer, which stays disabled until the turn closes. Both
 * SDKs default to minutes, which would be a hung request holding the user's
 * keyboard for the sake of a label. Ten seconds is generous for a handful of
 * output tokens and short enough that nobody sits through it twice.
 */
const TITLE_TIMEOUT_MS = 10_000;

/**
 * The ceiling on the title itself.
 *
 * Wider than the six words asked for, because it is counted in tokens and the
 * languages that need the most of them per word are exactly the ones this is
 * meant to serve — a Turkish title costs more here than its English
 * translation.
 */
const TITLE_MAX_TOKENS = 64;

/**
 * Parse the model's JSON-mode reply into a session title. Resilient by design:
 * any malformed / partial / unexpected shape yields null rather than throwing,
 * so a bad generation leaves the title unset — the sidebar keeps saying "New
 * chat", which is exactly where it started.
 */
export function parseTitleSuggestion(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const title = (parsed as { title?: unknown } | null)?.title;
  if (typeof title !== "string") return null;

  // Models wrap titles in quotes and end them with a period however plainly the
  // prompt asks them not to. Strip both here rather than trusting the prompt:
  // the prompt is a request, this is the guarantee. Newlines collapse too — a
  // title is one line in a narrow column, whatever the model thought.
  const cleaned = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();

  if (cleaned.length === 0) return null;
  return cleaned.slice(0, TITLE_MAX_CHARS);
}

/**
 * Build the titling prompt: name a conversation from the message that opened
 * it. JSON-only so parseTitleSuggestion can read it. The title is written in
 * the message's own language, so a Turkish question gets a Turkish title.
 */
export function buildTitleMessages(
  firstMessage: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You name conversations. Given the first message a person sent to an assistant, " +
        'write a short label for that conversation. Respond ONLY with JSON of the exact shape {"title":string}. ' +
        "Three to six words, naming the subject the person raised — not the fact that they asked a " +
        "question, and never a greeting. Write it in the same language as the message. " +
        "No quotation marks, no trailing period, no markdown, no prose outside the JSON.",
    },
    {
      role: "user",
      content: `First message: ${firstMessage.slice(0, SOURCE_MAX_CHARS)}`,
    },
  ];
}

/**
 * Name a conversation from the message that opened it.
 *
 * Never throws and never rejects. A title is a convenience riding along with a
 * reply the user actually asked for, so every way this can go wrong — a
 * refusal, an outage, a reply that isn't JSON — comes back as `title: null` and
 * the session keeps the name it had. The caller writes a title only when one
 * arrives.
 *
 * `tokens` is reported separately from `title` and is deliberately not zeroed
 * when the reply is unusable: OpenAI charged for it either way, and the caller
 * folds it into the same allowance write as the turn it rode along with.
 */
export async function generateSessionTitle(
  env: CompletionEnv,
  model: string,
  firstMessage: string,
): Promise<{ title: string | null; tokens: number }> {
  try {
    const { text, usage } = await complete(
      env,
      {
        model,
        messages: buildTitleMessages(firstMessage),
        json: true,
        // Naming a conversation is shaping, not thinking — the same call the
        // persona drafter makes, and for the same reason: a reasoning model
        // left to deliberate spends the ceiling below on thought and returns
        // an empty answer.
        reasoningEffort: "minimal",
        maxTokens: TITLE_MAX_TOKENS,
      },
      { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
    );
    return { title: parseTitleSuggestion(text), tokens: totalTokens(usage) };
  } catch (err) {
    console.error("session titling failed", err);
    return { title: null, tokens: 0 };
  }
}
