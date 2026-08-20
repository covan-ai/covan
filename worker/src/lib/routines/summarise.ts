// worker/src/lib/routines/summarise.ts
import OpenAI from "openai";
import type { RoutineEnv } from "../../types";
import { resolveModel } from "../models";
import type { SummariseInput } from "./executor";

/**
 * One LLM call per run, not per item: cheaper, and the user gets one message
 * instead of eight. The agent's persona is applied exactly as it is in chat —
 * a routine is the same colleague, reporting instead of answering.
 */
export function summariseWithOpenAI(env: RoutineEnv) {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  return async (input: SummariseInput): Promise<{ text: string; tokens: number }> => {
    const body = input.pageText
      ? `Watched page content:\n\n${input.pageText.slice(0, 20_000)}`
      : input.items
          .map((i) => `- ${i.title}\n  ${i.link}\n  ${i.summary.slice(0, 1_000)}`)
          .join("\n\n");

    const completion = await client.chat.completions.create({
      model: resolveModel(input.model),
      messages: [
        {
          role: "system",
          content: [input.persona, "You are running a scheduled routine for this team."]
            .filter(Boolean)
            .join("\n\n"),
        },
        { role: "user", content: `${input.instruction}\n\n${body}` },
      ],
    });

    return {
      text: completion.choices[0]?.message?.content ?? "",
      tokens: completion.usage?.total_tokens ?? 0,
    };
  };
}
