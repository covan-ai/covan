import type { AgentTool, ToolContext, ToolResult } from "../registry";

/**
 * Ask the person something, with up to three answers they can press.
 *
 * The thread draws it as the ask card under the reply (A2): a ring dot,
 * "Support is asking you", the question, and the answers as buttons. The
 * turn does not wait: it ends, and the person's answer is their next message,
 * whenever it comes — which is why a question can sit in the Inbox for hours
 * without expiring, where a paused confirmation could not.
 *
 * The question and the answers are written onto the reply as `messages.ask`
 * (0122) by the chat route, from this step's arguments (`askOf`); a thread
 * whose newest message carries one is waiting on its owner.
 *
 * Not for a routine run: nobody is watching one, so a question there would
 * never be seen. The model is told to say what it needs in the reply instead.
 */

export const MAX_ASK_QUESTION_CHARS = 300;
export const MAX_ASK_REPLY_CHARS = 60;
export const MAX_ASK_REPLIES = 3;

export type Ask = { question: string; replies: string[] };

/** The arguments as an ask, or null when they are not one. */
export function parseAsk(args: unknown): Ask | null {
  const a = args as { question?: unknown; replies?: unknown } | null;
  if (!a || typeof a.question !== "string") return null;
  const question = a.question.trim().slice(0, MAX_ASK_QUESTION_CHARS);
  if (!question) return null;
  const replies = (Array.isArray(a.replies) ? a.replies : [])
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.trim().slice(0, MAX_ASK_REPLY_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ASK_REPLIES);
  return { question, replies };
}

/**
 * What a turn asked, from its steps: the last `ask_person` that ran. Null when
 * it asked nothing, which is almost every turn.
 */
export function askOf(
  steps: ReadonlyArray<{ tool: string; status: string; request: unknown }>,
): Ask | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.tool === askPersonTool.name && step.status === "ok") return parseAsk(step.request);
  }
  return null;
}

export const askPersonTool: AgentTool = {
  name: "ask_person",
  description:
    "Ask the person one short question when you need their decision before going on — which " +
    "of two drafts, whether to send, what a term means here. Give up to three short answers " +
    "they can press. Use it at most once, at the end of your reply, and stop writing after " +
    "it: their answer arrives as their next message. Do not use it for questions you can " +
    "answer from documents or connected apps.",
  input: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: `One sentence, at most ${MAX_ASK_QUESTION_CHARS} characters.`,
      },
      replies: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_ASK_REPLIES,
        description: `Up to ${MAX_ASK_REPLIES} answers, each a few words, the likeliest first.`,
      },
    },
    required: ["question"],
  },
  destructive: false,
  isConfigured: () => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.routineRunId || ctx.continuation) {
      return {
        kind: "error",
        message:
          "nobody is watching this run, so a question would never be seen; say what you " +
          "need in your reply instead",
      };
    }
    const ask = parseAsk(args);
    if (!ask) return { kind: "error", message: "a question is required" };
    return {
      kind: "ok",
      content:
        "Asked. The person sees your question with the answers as buttons. Stop here — do not " +
        "repeat the question or add anything after it.",
    };
  },
};
