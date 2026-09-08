// worker/src/lib/routines/summarise.ts
import type { RoutineEnv } from "../../types";
import { resolveModel } from "../models";
import { complete, totalTokens } from "../completion";
import type { SummariseInput } from "./executor";

/**
 * What the model is told when it is allowed to send nothing.
 *
 * Phrased as a judgement about the *material*, not about the writing: "is there
 * anything here the instruction asked for" rather than "would this be a good
 * message". The second framing makes a model hedge — it can always find a way
 * to be useful — and hedging is exactly the paragraph this exists to stop.
 */
const DECISION_INSTRUCTION =
  "Return a JSON object with two fields. `relevant` is true only if the material below " +
  "contains something the instruction actually asked for, and false when it does not. " +
  "`summary` is your report, written as you normally would, and must be empty when " +
  "`relevant` is false.\n\n" +
  "Say false rather than writing a message explaining that nothing matched. A message " +
  "that says nothing happened is the thing this field exists to avoid: it is delivered " +
  "to a channel people read, and enough of them make them stop reading it.";

/** The decision, as the model returns it. Neither field is trusted to be there. */
type Decision = { relevant?: unknown; summary?: unknown };

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
 *
 * That one call now also decides whether to send at all, when the caller allows
 * it. Two questions and one call rather than two calls: a separate relevance
 * pass would double the bill on every run to answer something the model has
 * already had to work out in order to write the summary.
 */
export function summariseWithModel(env: RoutineEnv) {
  return async (
    input: SummariseInput,
  ): Promise<{ text: string; tokens: number; declined: boolean }> => {
    const body = input.pageText
      ? `Watched page content:\n\n${input.pageText.slice(0, 20_000)}`
      : input.items
          .map((i) => `- ${i.title}\n  ${i.link}\n  ${i.summary.slice(0, 1_000)}`)
          .join("\n\n");

    const { text, usage } = await complete(env, {
      model: resolveModel(input.model, env),
      json: input.mayDecline,
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
        ...(input.mayDecline ? [{ role: "system" as const, content: DECISION_INSTRUCTION }] : []),
        { role: "user", content: `${input.instruction}\n\n${body}` },
      ],
    });

    const tokens = totalTokens(usage);
    if (!input.mayDecline) return { text, tokens, declined: false };

    return { ...readDecision(text), tokens };
  };
}

/**
 * The model's answer, read so that every failure means "send it".
 *
 * This is the whole safety of the feature and it only points one way. A routine
 * that goes quiet is indistinguishable, from outside, from a routine with
 * nothing to report — so a parse bug here would not look like a bug, it would
 * look like a quiet week, for as long as it took somebody to get suspicious. A
 * routine that sends something it should have withheld is the noise we had
 * before, noticed immediately, and fixed by the next run.
 *
 * So: unreadable JSON, a missing `relevant`, a non-boolean `relevant`, or
 * `relevant: false` with a summary written anyway — all of them deliver.
 * `declined` is true only when the model said so plainly.
 */
function readDecision(text: string): { text: string; declined: boolean } {
  let decision: Decision;
  try {
    decision = JSON.parse(text) as Decision;
  } catch {
    // `completion.ts` already digs an object out of a fenced or prose-wrapped
    // reply, so reaching here means there was no object to find. The raw text
    // is the best summary available, and sending it beats silence.
    return { text, declined: false };
  }

  if (decision === null || typeof decision !== "object") return { text, declined: false };

  const summary = typeof decision.summary === "string" ? decision.summary : "";

  // Only an explicit `false` declines. `undefined`, a string "false", and
  // anything else a model might improvise all send.
  if (decision.relevant !== false) {
    // A well-formed object whose summary came back empty would deliver a blank
    // message, which is worse than either outcome this feature offers. Fall
    // back to the whole reply, which at least contains what the model wrote.
    return { text: summary || text, declined: false };
  }

  return { text: summary, declined: true };
}
