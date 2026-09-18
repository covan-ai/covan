import { complete, totalTokens, type CompletionEnv } from "./completion";

const FOLLOWUP_TIMEOUT_MS = 8_000;
const FOLLOWUP_MAX_TOKENS = 256;

const QUESTION_CAP = 400;
const ANSWER_CAP = 800;

export function buildFollowUpMessages(
  question: string,
  answer: string,
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You suggest follow-up questions. Given a question and the assistant's answer, " +
        "write 2–3 short, natural follow-up questions the user might ask next. " +
        "Each question should explore a different angle — deeper detail, a practical " +
        "application, or a related topic. Write in the same language as the question. " +
        'Respond ONLY with JSON: {"questions":["...","...","..."]}. ' +
        "No prose outside the JSON.",
    },
    {
      role: "user",
      content:
        `Question: ${question.slice(0, QUESTION_CAP)}\n\n` +
        `Answer: ${answer.slice(0, ANSWER_CAP)}`,
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
): Promise<{ questions: string[]; tokens: number }> {
  try {
    const { text, usage } = await complete(
      env,
      {
        model,
        messages: buildFollowUpMessages(question, answer),
        json: true,
        reasoningEffort: "minimal",
        maxTokens: FOLLOWUP_MAX_TOKENS,
      },
      { signal: AbortSignal.timeout(FOLLOWUP_TIMEOUT_MS) },
    );
    return { questions: parseFollowUps(text), tokens: totalTokens(usage) };
  } catch (err) {
    console.error("follow-up generation failed", err);
    return { questions: [], tokens: 0 };
  }
}
