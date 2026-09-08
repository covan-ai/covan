// worker/src/lib/routines/summarise.ts
import type { RoutineEnv } from "../../types";
import { resolveModel } from "../models";
import { complete, totalTokens } from "../completion";
import type { SummariseInput } from "./executor";

/**
 * One LLM call per run, not per item: cheaper, and the user gets one message
 * instead of eight. The agent's persona is applied exactly as it is in chat —
 * a routine is the same colleague, reporting instead of answering.
 *
 * "Exactly as in chat" now includes what the agent has read. It did not, and
 * the gap was invisible because both halves worked: the agent could quote the
 * handbook when someone asked it a question, and wrote the Monday digest as if
 * it had never seen one. So a routine watching a competitor's blog could not
 * say what the news meant for this company, which is the only reason to have
 * asked an agent rather than forwarded the feed.
 */
export function summariseWithModel(env: RoutineEnv) {
  return async (input: SummariseInput): Promise<{ text: string; tokens: number }> => {
    const body = input.pageText
      ? `Watched page content:\n\n${input.pageText.slice(0, 20_000)}`
      : input.items
          .map((i) => `- ${i.title}\n  ${i.link}\n  ${i.summary.slice(0, 1_000)}`)
          .join("\n\n");

    const { text, usage } = await complete(env, {
      model: resolveModel(input.model, env),
      messages: [
        {
          role: "system",
          content: [input.persona, "You are running a scheduled routine for this team."]
            .filter(Boolean)
            .join("\n\n"),
        },
        // The grounding block gets its own message rather than being folded
        // into the persona, which is how `routes/chat.ts` assembles it and for
        // the same two reasons: the persona is the agent's standing identity
        // and this is one run's material, and keeping retrieved text in a
        // separate message is what stops a passage that happens to read like an
        // instruction from being read as one.
        //
        // Nothing is sent when retrieval found nothing, so an agent with no
        // documents gets exactly the prompt it got before this existed.
        ...(input.ragBlock ? [{ role: "system" as const, content: input.ragBlock }] : []),
        { role: "user", content: `${input.instruction}\n\n${body}` },
      ],
    });

    return { text, tokens: totalTokens(usage) };
  };
}
