/**
 * The opening prompts an empty conversation offers.
 *
 * Pulled out of the chat route and kept free of React for the same reason
 * cron-to-prose.ts and onboarding-flow.ts are: the interesting part is a
 * decision, and a decision is worth testing without rendering a chat.
 *
 * The decision is which four to show. Every starter used to be about the model
 * — "What can you help me with?" — and none of them about the documents, so the
 * fastest path through a brand new agent produced an answer with no citation on
 * it. That is the one reply that makes Covan look like every other chat box.
 * When the agent has something indexed, the first suggestion names a real file,
 * because an answer that cites a file the user recognises is the entire pitch.
 */

/** What to offer when there is nothing retrievable behind the agent. */
export const GENERAL_STARTERS: readonly string[] = [
  "What can you help me with?",
  "Summarize what you know",
  "Walk me through an example",
  "Draft something for me",
];

export type StarterDocument = {
  name: string;
  /**
   * Chunked and embedded. An upload that has not finished cannot ground
   * anything yet, and naming it would promise a citation that does not arrive.
   */
  indexed: boolean;
};

export function startersFor(documents: readonly StarterDocument[]): string[] {
  const ready = documents.filter((d) => d.indexed);
  if (ready.length === 0) return [...GENERAL_STARTERS];

  return [
    `What does ${ready[0].name} say?`,
    ready.length > 1 ? "What do these documents have in common?" : "Summarize what you know",
    "What should I know that I haven't asked about?",
    "Draft something for me",
  ];
}
