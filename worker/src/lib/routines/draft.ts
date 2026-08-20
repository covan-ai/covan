import { z } from "zod";
import { isValidCron } from "./schedule";
import { assertFetchableUrl } from "./url-guard";

export const draftSchema = z.object({
  name: z.string().min(1),
  sourceKind: z.enum(["rss", "web", "none"]),
  sourceUrl: z.string().nullable(),
  cron: z.string().min(1),
  instruction: z.string().min(1),
  channelKind: z.enum(["slack", "email"]),
});

export type RoutineDraft = z.infer<typeof draftSchema> & { timezone: string };

export type DraftDeps = {
  complete: (prompt: string) => Promise<string>;
  timezone: string;
  ownHosts: string[];
};

const SYSTEM = `Convert the user's request into a routine definition.
Reply with JSON only, matching exactly:
{"name": string, "sourceKind": "rss"|"web"|"none", "sourceUrl": string|null,
 "cron": string (5-field cron), "instruction": string, "channelKind": "slack"|"email"}

Rules:
- A subreddit becomes sourceKind "rss" with url https://www.reddit.com/r/<sub>/new/.rss
- A page to watch for changes becomes "web". No external source becomes "none".
- "every 15 minutes" is "*/15 * * * *"; "every morning at 9" is "0 9 * * *".
- instruction is what the agent should do with what it finds, in the user's language.`;

/**
 * The LLM reasons exactly once, here at setup time. Everything the engine does
 * afterwards is deterministic, which is why "why did my routine behave
 * differently today?" is never a question anyone has to answer.
 *
 * The draft is validated against the same guards the engine uses, so an
 * impossible routine is rejected while the user is still looking at it.
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
  if (draft.sourceKind !== "none") {
    if (!draft.sourceUrl) throw new Error(`a ${draft.sourceKind} routine needs a url`);
    assertFetchableUrl(draft.sourceUrl, deps.ownHosts);
  }

  return { ...draft, timezone: deps.timezone };
}
