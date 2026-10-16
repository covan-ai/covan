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

/**
 * "In the user's language" used to be the language rule, and the model had to
 * guess who the user was: these rules are English, the request may not be,
 * and gpt-4.1 once answered an English request with a Japanese instruction —
 * which every run then followed, so the reports came in Japanese too. The rule
 * now names the text it means.
 *
 * The instruction also used to keep the request's "every weekday at 9" and
 * "email it to me". The schedule is `cron` and the delivery is `channelKind`;
 * left in the instruction they read to the run as a task of their own, and the
 * run answered that it could not schedule or send email.
 */
const SYSTEM = `Convert the request below into a routine definition.
Reply with JSON only, matching exactly:
{"name": string, "sourceKind": "none", "sourceUrl": null,
 "cron": string (5-field cron), "instruction": string, "channelKind": "slack"|"email"}

Rules:
- Routines are standing orders for the agent to run tasks on a schedule using its tools and knowledge. sourceKind is always "none" and sourceUrl is null.
- "every 15 minutes" is "*/15 * * * *"; "every morning at 9" is "0 9 * * *".
- instruction is what the agent should do each time the routine runs, written as a direct task. It describes the work only: leave out when it runs (that is cron) and how the result is sent (that is channelKind), so no "every weekday at 9", "email it to me" or "post it to Slack".
- Write name and instruction in the same language as the text after "Request:". Not the language of these rules, and never a third language.`;

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
