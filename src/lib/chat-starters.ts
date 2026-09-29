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

import type { ConnectedApp } from "./connected-apps";

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

/**
 * One opening line per connected application.
 *
 * A separate export rather than more branches inside `startersFor`, and the
 * reason is the group above: the empty screen shows Knowledge and Connected
 * apps as two labelled regions, and `startersFor`'s own contract — exactly
 * four, laid out in a two-column grid — is what keeps the first region from
 * growing a widowed cell. Mixing app lines into that four would break a rule
 * its test has been guarding since before this screen existed.
 *
 * EVERY SENTENCE IS A QUESTION. That is not a style note. A connected toolkit
 * carries whatever operations the grant happened to include, and we cannot see
 * which — `ToolConnection` records the application, not its permissions. An
 * imperative ("Search Drive for the Q3 review") promises an operation that may
 * not be there, which is failure mode #1 wearing a verb. A question about the
 * same thing degrades honestly: if the grant cannot do it, the answer says so
 * and the interface never claimed otherwise.
 */
const APP_STARTER: Record<string, string> = {
  github: "What pull requests are waiting on me?",
  gmail: "What's waiting in my inbox?",
  googlecalendar: "What's on my calendar this week?",
  googledocs: "What did I write in my most recent doc?",
  googledrive: "What's in my Drive that I should read?",
  googlesheets: "What's in my most recent spreadsheet?",
  hubspot: "Which deals have gone quiet?",
  jira: "What's assigned to me in Jira?",
  linear: "What's assigned to me in Linear?",
  notion: "What have we written down in Notion about this?",
  slack: "What did the team decide in Slack this week?",
};

/**
 * The applications we wrote a sentence for, derived from the table rather than
 * listed beside it — two lists of the same thing drift, and the drift would be
 * silent.
 */
export const CURATED_APP_SLUGS: readonly string[] = Object.keys(APP_STARTER);

export type AppStarter = {
  app: ConnectedApp;
  starter: string;
};

/**
 * The order is the caller's. `mergeConnectedApps` already sorted by slug so the
 * grid does not reshuffle when an unrelated app is connected, and sorting again
 * here would put one decision in two places and let them disagree.
 */
export function appStartersFor(apps: readonly ConnectedApp[]): AppStarter[] {
  return apps.map((app) => ({
    app,
    starter: APP_STARTER[app.slug] ?? `What can you do with ${app.name}?`,
  }));
}
