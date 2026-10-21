import { complete, type CompletionEnv } from "./completion";
import { completionSpend, type Spend } from "./entitlements";

const FOLLOWUP_TIMEOUT_MS = 8_000;
/**
 * Three short questions as JSON. 256 was enough for GPT and not for Claude
 * Haiku, which the hosted build drafts these on: 3 of 132 drafts in October
 * 2026 stopped at exactly 256 tokens, and a list cut mid-string is dropped
 * whole. Twice that leaves room for three long Turkish questions; a draft that
 * still hits it is reported as cut off rather than parsed (see below).
 */
const FOLLOWUP_MAX_TOKENS = 512;

const QUESTION_CAP = 400;
const ANSWER_CAP = 800;
/**
 * How many earlier questions the drafter is shown, so it does not offer one
 * of them back. The most recent ones, because those are the ones a reader
 * still has in view when the chips appear.
 */
export const ASKED_LIMIT = 8;

export function buildFollowUpMessages(
  question: string,
  answer: string,
  asked: readonly string[] = [],
): { role: "system" | "user"; content: string }[] {
  // Earlier questions in this conversation, newest last. A tester watched the
  // chips offer the question they had just had answered; the drafter had only
  // ever seen the latest exchange, so it had no way to know.
  const earlier = asked
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(-ASKED_LIMIT)
    .map((q) => `- ${q.slice(0, QUESTION_CAP)}`);
  return [
    {
      role: "system",
      content:
        "You suggest follow-up questions. Given a question and the assistant's answer, " +
        "write 2–3 short, natural follow-up questions the user might ask next. " +
        "Each question should explore a different angle — deeper detail, a practical " +
        "application, or a related topic. Write in the same language as the question. " +
        "Never suggest a question that was already asked in this conversation, or a " +
        "rewording of one. " +
        'Respond ONLY with JSON: {"questions":["...","...","..."]}. ' +
        "No prose outside the JSON.",
    },
    {
      role: "user",
      content:
        `Question: ${question.slice(0, QUESTION_CAP)}\n\n` +
        `Answer: ${answer.slice(0, ANSWER_CAP)}` +
        (earlier.length > 0
          ? `\n\nAlready asked in this conversation:\n${earlier.join("\n")}`
          : ""),
    },
  ];
}

export function parseFollowUps(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const questions = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
}

export async function generateFollowUps(
  env: CompletionEnv,
  model: string,
  question: string,
  answer: string,
  asked: readonly string[] = [],
): Promise<{ questions: string[]; spend: Spend | null }> {
  try {
    const { text, usage, finishReason } = await complete(
      env,
      {
        model,
        messages: buildFollowUpMessages(question, answer, asked),
        json: true,
        reasoningEffort: "minimal",
        maxTokens: FOLLOWUP_MAX_TOKENS,
      },
      { signal: AbortSignal.timeout(FOLLOWUP_TIMEOUT_MS) },
    );
    const spend = completionSpend(model, usage, "follow_ups");
    // A list that stopped at the ceiling is cut inside a string. Parsing it
    // yields nothing anyway; saying why in the log is the difference between
    // "the model ignored the format" and "the format needs more room".
    if (finishReason === "length") {
      console.error("follow-up draft cut off at the ceiling", { model });
      return { questions: [], spend };
    }
    return { questions: parseFollowUps(text), spend };
  } catch (err) {
    console.error("follow-up generation failed", err);
    return { questions: [], spend: null };
  }
}
