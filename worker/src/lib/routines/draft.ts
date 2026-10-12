import { z } from "zod";
import { isValidCron } from "./schedule";

export const draftSchema = z.object({
  name: z.string().min(1),
  sourceKind: z.enum(["rss", "web", "none"]),
  sourceUrl: z.string().nullable(),
  cron: z.string().min(1),
  instruction: z.string().min(1),
  channelKind: z.enum(["slack", "email"]),
});

/**
 * Always a scheduled task. The create dialog stopped offering a feed or a page
 * as a source (covan#241), so a draft naming one would land on a form with no
 * field showing the URL it was about to watch.
 */
export type RoutineDraft = Omit<z.infer<typeof draftSchema>, "sourceKind" | "sourceUrl"> & {
  sourceKind: "none";
  sourceUrl: null;
  timezone: string;
};

export type DraftDeps = {
  complete: (prompt: string) => Promise<string>;
  timezone: string;
};

const SYSTEM = `Convert the user's request into a routine definition.
Reply with JSON only, matching exactly:
{"name": string, "sourceKind": "none", "sourceUrl": null,
 "cron": string (5-field cron), "instruction": string, "channelKind": "slack"|"email"}

Rules:
- Routines are standing orders for the agent to run tasks on a schedule using its tools and knowledge. sourceKind is always "none" and sourceUrl is null.
- "every 15 minutes" is "*/15 * * * *"; "every morning at 9" is "0 9 * * *".
- instruction is what the agent should do when the routine runs, in the user's language.`;

/**
 * The LLM reasons exactly once, here at setup time. Everything the engine does
 * afterwards is deterministic, which is why "why did my routine behave
 * differently today?" is never a question anyone has to answer.
 *
 * The draft is validated against the same cron parser the engine uses, so an
 * impossible schedule is rejected while the user is still looking at it.
 */
export async function parseDraft(text: string, deps: DraftDeps): Promise<RoutineDraft> {
  const raw = await deps.complete(`${SYSTEM}\n\nRequest: ${text}`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("could not read a routine out of that request");
  }

  const draft = draftSchema.parse(parsedJson);

  if (!isValidCron(draft.cron, deps.timezone)) {
    throw new Error(`unusable cron expression: ${draft.cron}`);
  }

  // The prompt asks for `none` every time, and the schema still accepts `rss`
  // and `web` so a model that answers otherwise does not cost the person their
  // whole draft. It is folded into a scheduled task instead, and the URL moves
  // into the instruction rather than being dropped: it is usually the one thing
  // in the request the instruction would not otherwise carry.
  const url = draft.sourceKind !== "none" ? draft.sourceUrl?.trim() : "";
  const instruction = url ? `${draft.instruction}\n\nSource: ${url}` : draft.instruction;

  return {
    ...draft,
    sourceKind: "none",
    sourceUrl: null,
    instruction,
    timezone: deps.timezone,
  };
}
