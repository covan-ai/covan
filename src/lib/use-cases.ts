import { englishT, msg, type Translate } from "@/i18n";
import type { AgentMarkName } from "@/components/agent-mark";
import { KIND_NAME, type ArrivalKind } from "./arrivals";
import {
  FROM_THE_MAILBOX,
  arrivalTemplateById,
  fillTemplate,
  type RoutineTemplate,
  type TemplateRequirement,
} from "./routine-templates";
import type { EventChoice, RoutineTriggerKind } from "./routines-api";

/**
 * The use cases: every routine and agent a person can start from, in one
 * catalogue (spec: 2026-10-27-use-cases-design.md, "The catalogue").
 *
 * The page at `/routines/use-cases` draws these as cards; picking a routine
 * card opens the editor at `?template=<id>`, and picking an agent card opens
 * "New agent" filled in. Nothing here calls a model or writes a row: a use
 * case is a routine written in advance plus what it needs, and the routine it
 * becomes is a routine like any other.
 *
 * What a person reads (the label, the card's prompt, a routine's name, an
 * agent's name) is a key (`msg`), drawn with `lookup(t, …)`. What the model
 * reads (a routine's instruction, an agent's persona) stays English, as the
 * existing templates' and `personaFor`'s do: they are prompts, and the person
 * can rewrite them before anything runs.
 *
 * Rules every card keeps, held by `use-cases.test.ts`:
 *
 * - A card that changes something names the app in `needs.changes`, and its
 *   instruction ends "<what> only. Never send, reply, delete or change
 *   anything else there." The standing permission is per app, not per
 *   operation, so that sentence is what keeps a run, and its report, to what
 *   the card said it would do.
 * - A card that only reads mail ends its instruction with `FROM_THE_MAILBOX`.
 * - No instruction names a catalogue operation. Which one applies depends on
 *   what the person connected, and a made-up one is marked active and never
 *   runs; the agent finds the right one with the tools it has.
 * - No feed or page source: the editor has no URL field (covan#241). Cards
 *   that watch the web use web search or the browser.
 *
 * Dropped on the way: `knowledge-to-slack`, a Monday note of what changed in
 * Knowledge. No tool lists documents by date, so the card would claim what
 * the code cannot back.
 */

export type UseCaseSection = "inbox" | "team" | "customers" | "ops" | "insight";

/**
 * What a card shows above its title: an app's logo (a Composio toolkit), or a
 * word where there is no app to show. `github` and `slack` as words are the
 * native webhook and the native install, which deliver or trigger; reading
 * either through a tool is a `{ toolkit }`.
 */
export type AppMark =
  { toolkit: string } | "knowledge" | "browser" | "web" | "github" | "slack" | "email";

export type UseCaseNeeds = {
  /**
   * Composio toolkits, as any-of groups: `[["gmail", "outlook"],
   * ["googlecalendar", "outlook"]]` is a mailbox and a calendar, from either
   * vendor. Tool connections only, never the native Slack install, which
   * delivers and cannot be read through.
   */
  connections?: string[][];
  /** The toolkits a run changes things in. Each one is in a `connections` group. */
  changes?: string[];
  /** A synced source the routine starts from (`sourceKind: "connection"`). */
  source?: "notion" | "drive";
  /** Uses the browser on a scheduled run. */
  browser?: boolean;
  /** The agent must have web search on. */
  webSearch?: boolean;
  /** The four `TemplateRequirement`s. These block a card rather than add a note to it. */
  admin?: boolean;
  documents?: boolean;
  gapReport?: boolean;
  enoughPeople?: boolean;
};

type UseCaseBase = {
  /**
   * Stable, and the `?template=` value in a URL: renaming one breaks a link.
   * At most 31 characters, so `use-case:<id>` fits an onboarding step id.
   */
  id: string;
  section: UseCaseSection;
  /** A key (`msg`). */
  label: string;
  /** A key (`msg`): the card's body, in the first person. */
  prompt: string;
  apps: AppMark[];
  needs: UseCaseNeeds;
};

export type RoutineUseCase = UseCaseBase & {
  kind: "routine";
  routine: RoutineTemplate["draft"] & {
    /** Omitted means `schedule`. */
    triggerKind?: RoutineTriggerKind;
    /** With `triggerKind: "event"`: the entry the editor pre-chooses. */
    event?: EventChoice;
    /** Each run's output is filed into a folder the person picks in the editor. */
    fileToFolder?: boolean;
    endsAfterRuns: number | null;
  };
};

export type AgentUseCase = UseCaseBase & {
  kind: "agent";
  agent: {
    /** A key (`msg`). */
    name: string;
    avatar: AgentMarkName;
    /** English: a prompt, like a routine's instruction. */
    persona: string;
    webSearch?: boolean;
    mode?: "normal" | "brainstorm";
  };
};

export type UseCase = RoutineUseCase | AgentUseCase;

/** Keys (`msg`): each section's eyebrow and the muted qualifier beside it. */
export const SECTIONS: { id: UseCaseSection; title: string; qualifier: string }[] = [
  { id: "inbox", title: msg("Inbox and calendar"), qualifier: msg("Morning digests and drafts") },
  { id: "team", title: msg("Team and knowledge"), qualifier: msg("Works with nothing connected") },
  {
    id: "customers",
    title: msg("Customers and sales"),
    qualifier: msg("Deals, meetings and support"),
  },
  {
    id: "ops",
    title: msg("Operations and admin"),
    qualifier: msg("Receipts, issues and decisions"),
  },
  { id: "insight", title: msg("Research and insight"), qualifier: msg("The web, read for you") },
];

/** What each toolkit a card names is called. Product names, so never translated. */
export const TOOLKIT_NAME: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  hubspot: "HubSpot",
  linear: "Linear",
  github: "GitHub",
  notion: "Notion",
  slack: "Slack",
};

/** The three the welcome's connect step shows, not clickable. */
export const WELCOME_CARDS = ["daily-brief", "questions-waiting", "day-ahead"] as const;

const MAIL = ["gmail", "outlook"];
const CALENDAR = ["googlecalendar", "outlook"];
const MAIL_MARKS: AppMark[] = [{ toolkit: "gmail" }, { toolkit: "outlook" }];
const CALENDAR_MARKS: AppMark[] = [{ toolkit: "googlecalendar" }, { toolkit: "outlook" }];

/** Said by every card that writes from what the team has written down. */
const GROUNDED =
  "Ground it in what my team has written down and name the document it came from; where the documents do not answer, say so instead of guessing.";

/** An inbox card from the scan's proposal for a kind, the kind's plain name filled in. */
function fromArrivals(templateId: string, kind: ArrivalKind) {
  const template = arrivalTemplateById(templateId);
  if (!template) throw new Error(`No arrival template named ${templateId}`);
  return {
    label: template.label,
    routine: { ...fillTemplate(template, KIND_NAME[kind]), endsAfterRuns: null },
  };
}

// The two templates that were here before the catalogue, moved verbatim from
// `routine-templates.ts`. `templateById` hands back exactly these for an old
// `?template=first-week` or `?template=gap-report` link.
//
// There was a third, `weekly-digest`: a feed, once a week. It needed the URL
// field covan#241 took out of the dialog on purpose, so it could only ever be
// shown as unavailable. An old `?template=weekly-digest` link opens step 1,
// which is what any unknown id does.
const FIRST_WEEK: RoutineTemplate = {
  id: "first-week",
  label: msg("Somebody's first week"),
  blurb: msg("One note each morning for a week, from what the team has written down."),
  draft: {
    name: msg("First week"),
    sourceKind: "none",
    scheduleCron: "0 9 * * *",
    channelKind: "email",
    // The curriculum, and the whole reason this series varies. The engine
    // tells the model which morning it is (0074 + executor's run position);
    // these seven subjects are the six KNOWLEDGE_TEMPLATES plus a closing
    // one, so a team that filled in the six files the product already
    // suggests gets a week that walks through them in an order somebody
    // chose. No memory, no second call, and no reliance on the model
    // deciding to be different today.
    instruction: `Each morning of somebody's first week, cover one subject from the team's own documents. The run tells you which morning this is; use it to pick:

1. What the company does, who for, and what it deliberately does not do.
2. How the team works — who owns what, which tools, and how work gets picked up.
3. The product: what it does, where its limits are, and what people get wrong.
4. The questions that come up every week, and their answers.
5. The team's own vocabulary — the words that mean something specific here.
6. Decisions already made, and the reasoning behind them.
7. Anything important in the documents that none of the first six covered.

Write it as a short note to one new person: what it is, why it matters here, and which document to read for the detail. Ground every claim in the documents and name the file it came from. If the documents say nothing about this morning's subject, say so plainly and point at the nearest thing they do cover — do not fill the gap from general knowledge.`,
  },
  requires: ["documents"],
  endsAfterRuns: 7,
};

const GAP_REPORT: RoutineTemplate = {
  id: "gap-report",
  label: msg("What nobody wrote down"),
  blurb: msg("Weekly: the topics your team asked about that no document covered."),
  draft: {
    name: msg("Coverage gaps"),
    sourceKind: "workspace",
    scheduleCron: "0 9 * * 1",
    channelKind: "email",
    // Read by nothing. A `workspace` run renders its own report in code
    // (coverage-render.ts) and makes exactly one model call, for the cluster
    // labels — so there is no prompt for an instruction to go into. The field
    // is `not null` on the table, so it says what the routine is instead of
    // being blank.
    instruction:
      "Report the topics this workspace asked about that its own documents did not cover. Clustered, never named, and never anybody's question text.",
  },
  requires: ["admin", "gapReport", "enoughPeople"],
  endsAfterRuns: null,
};

/** A template from before the catalogue, as a card: its blurb is the card's body. */
function fromTemplate(
  template: RoutineTemplate,
  card: Pick<UseCaseBase, "section" | "apps" | "needs">,
): RoutineUseCase {
  return {
    kind: "routine",
    id: template.id,
    label: template.label,
    prompt: template.blurb,
    ...card,
    routine: { ...template.draft, endsAfterRuns: template.endsAfterRuns },
  };
}

export const USE_CASES: UseCase[] = [
  // ---- Inbox and calendar ---------------------------------------------------
  {
    kind: "routine",
    id: "daily-brief",
    section: "inbox",
    label: msg("Daily brief"),
    prompt: msg(
      "Each weekday at 08:00, give me my top three priorities, the replies I owe, what I'm waiting on, and the meetings to prepare for.",
    ),
    apps: [...MAIL_MARKS, { toolkit: "googlecalendar" }],
    needs: { connections: [MAIL, CALENDAR] },
    routine: {
      name: msg("Daily brief"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction: `Each weekday morning, write my brief for the day in four short parts: my top three priorities today, judged from my mail and calendar; the replies I owe, oldest first, with who is waiting and since when; what I am waiting on from other people; and today's meetings that need preparing, with one line each on what to prepare. Name people, not addresses. Keep it short enough to read in two minutes. ${FROM_THE_MAILBOX}`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "questions-waiting",
    section: "inbox",
    prompt: msg(
      "Each morning, list the questions people outside my team sent me since yesterday, each with a draft reply from what my team has written down.",
    ),
    apps: [...MAIL_MARKS, "knowledge"],
    needs: { connections: [MAIL] },
    ...fromArrivals("arrivals-questions", "question"),
  },
  {
    kind: "routine",
    id: "decisions-waiting",
    section: "inbox",
    prompt: msg(
      "Each morning, show me what is waiting on a decision or an approval from me, oldest first.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    ...fromArrivals("arrivals-requests", "request"),
  },
  {
    kind: "routine",
    id: "day-ahead",
    section: "inbox",
    prompt: msg(
      "Each morning, walk me through today's meetings: the time, the topic, who is in each, and the last thread I had with them.",
    ),
    apps: CALENDAR_MARKS,
    needs: { connections: [CALENDAR] },
    ...fromArrivals("arrivals-day-ahead", "scheduling"),
  },
  {
    kind: "routine",
    id: "what-changed",
    section: "inbox",
    prompt: msg(
      "Each morning, tell me in one paragraph what actually changed from the updates that arrived, then what needs me.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    ...fromArrivals("arrivals-updates", "update"),
  },
  {
    kind: "routine",
    id: "weekly-admin",
    section: "inbox",
    prompt: msg(
      "Each Friday, list the week's invoices, renewals, contracts and account mail, with amounts and due dates, soonest first.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    ...fromArrivals("arrivals-admin", "admin"),
  },
  {
    kind: "routine",
    id: "candidates",
    section: "inbox",
    prompt: msg(
      "Each morning, put new applications and interview mail in one list: who, which role, which stage, and what they need from me.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    ...fromArrivals("arrivals-candidates", "people"),
  },
  {
    kind: "routine",
    id: "reply-drafts",
    section: "inbox",
    label: msg("Reply drafts, ready to send"),
    prompt: msg(
      "Each morning, write a Gmail draft for every outside mail waiting on my reply, grounded in my team's documents. I send them myself.",
    ),
    apps: [{ toolkit: "gmail" }, "knowledge"],
    needs: { connections: [["gmail"]], changes: ["gmail"] },
    routine: {
      name: msg("Reply drafts"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction: `Each morning, find the mail from people outside my team that is still waiting on my reply in my connected Gmail. For each, write a reply as a draft in that thread. ${GROUNDED} Then tell me, one line per draft, who it is for and what it says. Create drafts only. Never send, reply, delete or change anything else there.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "friday-cleanup",
    section: "inbox",
    label: msg("Friday inbox cleanup"),
    prompt: msg(
      "Every Friday, archive the newsletters and notifications older than a week, and label what is still waiting on my reply. Nothing is deleted.",
    ),
    apps: [{ toolkit: "gmail" }],
    needs: { connections: [["gmail"]], changes: ["gmail"] },
    routine: {
      name: msg("Inbox cleanup"),
      sourceKind: "none",
      scheduleCron: "0 16 * * 5",
      channelKind: "email",
      instruction: `Every Friday, tidy my connected Gmail. Archive the newsletters, notifications and other automated mail older than seven days by taking them out of the inbox. Put the label "Waiting on me" on the threads from people that still wait on my reply, creating the label if it does not exist. Then tell me what you archived, counted by sender, and list the threads you labelled. Archive and label only. Never send, reply, delete or change anything else there.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "focus-blocks",
    section: "inbox",
    label: msg("Protect focus blocks"),
    prompt: msg(
      "Each Sunday evening, look at my next week and put two-hour focus blocks where the days are fragmented, as tentative events.",
    ),
    apps: [{ toolkit: "googlecalendar" }],
    needs: { connections: [["googlecalendar"]], changes: ["googlecalendar"] },
    routine: {
      name: msg("Focus blocks"),
      sourceKind: "none",
      scheduleCron: "0 18 * * 0",
      channelKind: "email",
      instruction: `Each Sunday evening, read the coming Monday to Friday in my connected Google Calendar. On each working day with no free stretch of two hours, find the two-hour gap that breaks up the fewest meetings and create a tentative event called "Focus" there, with no guests and never over an existing event. At most one block a day. Then tell me the blocks you created, by day and time, and the days you left alone. Create tentative events with no guests only. Never send, reply, delete or change anything else there.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "overdue-replies",
    section: "inbox",
    label: msg("Three days without a reply"),
    prompt: msg(
      "Each evening, list every outside thread that has waited three days for my reply, one line each with a suggested answer.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    routine: {
      name: msg("Overdue replies"),
      sourceKind: "none",
      scheduleCron: "0 18 * * 1-5",
      channelKind: "email",
      instruction: `Each evening, find the threads from people outside my team where the last message is theirs and is at least three days old, oldest first. For each, one line: who it is from (name and company, not the address), what they asked, how long they have waited, and a one-sentence suggested answer. ${GROUNDED} ${FROM_THE_MAILBOX}`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "agent",
    id: "reply-drafter",
    section: "inbox",
    label: msg("A drafter for replies"),
    prompt: msg(
      "Write replies for my team to check and send, and never claim what our documents do not say.",
    ),
    apps: ["knowledge"],
    needs: {},
    agent: {
      name: msg("Drafts"),
      avatar: "fox",
      persona:
        "You write replies for the team to check and send; you never send anything yourself. Ground every reply in the documents in Knowledge and name the one you used. Never claim what the documents do not say: where they are silent, write around the gap and tell the person what to check. Match the tone of the mail you are answering, keep it short, and ask when it is unclear who the reply is for.",
    },
  },
  {
    kind: "agent",
    id: "mailbox-watcher",
    section: "inbox",
    label: msg("Somebody watching the inbox"),
    prompt: msg("Keep an eye on my mailbox and tell me what needs a person. Never send anything."),
    apps: ["email"],
    needs: {},
    agent: {
      name: msg("Inbox"),
      avatar: "owl",
      persona:
        "You keep an eye on the mailbox you are given and say what needs a person: who wrote, what they want, and by when. You read; you never send, reply to, archive or delete anything. Name people, not addresses. Put what is urgent first, and when you cannot tell whether something matters, say so rather than guess.",
    },
  },

  // ---- Team and knowledge -----------------------------------------------------
  fromTemplate(FIRST_WEEK, {
    section: "team",
    apps: ["knowledge", "email"],
    needs: { documents: true },
  }),
  fromTemplate(GAP_REPORT, {
    section: "team",
    apps: ["knowledge"],
    needs: { admin: true, gapReport: true, enoughPeople: true },
  }),
  {
    kind: "routine",
    id: "notion-week",
    section: "team",
    label: msg("What changed in Notion this week"),
    prompt: msg(
      "Each Friday, tell me what was added or changed in our Notion this week, with a decision or a new process first.",
    ),
    apps: ["knowledge"],
    needs: { source: "notion" },
    routine: {
      name: msg("Notion this week"),
      sourceKind: "connection",
      scheduleCron: "0 9 * * 5",
      channelKind: "email",
      instruction:
        "Each Friday, from the Notion pages added or changed this week, write what changed: decisions and new processes first, then everything else, one line each with the page's title. Skip edits that changed nothing a reader would notice.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "drive-week",
    section: "team",
    label: msg("New in the shared drive"),
    prompt: msg(
      "Each Friday, list the documents added or changed in our connected folder this week, with a line on each.",
    ),
    apps: ["knowledge"],
    needs: { source: "drive" },
    routine: {
      name: msg("Drive this week"),
      sourceKind: "connection",
      scheduleCron: "0 9 * * 5",
      channelKind: "email",
      instruction:
        "Each Friday, list the documents added or changed in the connected folder this week, new ones first. For each: its title and one line on what it is or what changed in it. Skip a change that only touched formatting.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "standup",
    section: "team",
    label: msg("Standup from the channel"),
    prompt: msg(
      "Each morning, read yesterday in our team channel and write five lines: done, doing, blocked, decided, and what needs an answer.",
    ),
    apps: [{ toolkit: "slack" }],
    needs: { connections: [["slack"]] },
    routine: {
      name: msg("Standup"),
      sourceKind: "none",
      scheduleCron: "0 9 * * 1-5",
      channelKind: "email",
      instruction: `Each weekday morning, read yesterday's messages in our team channel in my connected Slack with the tools you have.

[Channel: …]

Write five lines: what got done, what is in progress, what is blocked and on whom, what was decided, and which question still needs an answer. Name people, not handles. Only read Slack: never post, reply, react or change anything there.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "slack-unanswered",
    section: "team",
    label: msg("Questions nobody answered"),
    prompt: msg(
      "Each evening, find the questions in our support channel that still have no reply, and draft an answer from our documents for each, or say which document is missing.",
    ),
    apps: [{ toolkit: "slack" }, "knowledge"],
    needs: { connections: [["slack"]] },
    routine: {
      name: msg("Unanswered questions"),
      sourceKind: "none",
      scheduleCron: "0 17 * * 1-5",
      channelKind: "email",
      instruction: `Each evening, read today's messages in our support channel in my connected Slack with the tools you have.

[Channel: …]

List every question that still has no reply in its thread: who asked, the question in one line, and a draft answer. ${GROUNDED} Where nothing covers it, name the document the team should write. Only read Slack: never post, reply, react or change anything there; the drafts are for me.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "shipped",
    section: "team",
    label: msg("What shipped, in customer words"),
    prompt: msg(
      "When something is pushed to main, say what shipped in three sentences a customer would understand, and send it to the team channel.",
    ),
    apps: ["github", "slack"],
    needs: {},
    routine: {
      name: msg("What shipped"),
      sourceKind: "none",
      // Not read: an event routine runs when its event arrives. The column is
      // `not null`, and this is a schedule the engine accepts.
      scheduleCron: "0 9 * * 1",
      channelKind: "slack",
      triggerKind: "event",
      event: { type: "github.push", config: { branch: "main" } },
      instruction:
        'Something was just pushed to main. From the commits in this event, say what shipped in at most three sentences a customer would understand: what they can do now that they could not, or what got better. Never name files, functions or internals. If nothing in the push would be noticed by a customer, say "Nothing customer-facing" and stop there.',
      endsAfterRuns: null,
    },
  },
  {
    kind: "agent",
    id: "summariser",
    section: "team",
    label: msg("Summaries of long documents"),
    prompt: msg("Turn long documents into what matters, with the page each point came from."),
    apps: ["knowledge"],
    needs: {},
    agent: {
      name: msg("Summaries"),
      avatar: "cat",
      persona:
        "You turn long documents into what matters for the person asking: the decision, the numbers, the deadlines and what changed, in a few lines. Every point names the document and the page or section it came from. You leave out what is background, say plainly when a document does not cover what was asked, and ask what the summary is for when that would change what goes in it.",
    },
  },
  {
    kind: "agent",
    id: "sparring",
    section: "team",
    label: msg("A sparring partner"),
    prompt: msg(
      "Argue the other side of my idea, find its weak point, and offer me three options.",
    ),
    apps: [],
    needs: {},
    agent: {
      name: msg("Sparring partner"),
      avatar: "blob",
      mode: "brainstorm",
      persona:
        "You are a sparring partner. When somebody brings you an idea, you argue the other side honestly, find the weakest point and say why it is weak, then offer three different ways forward with what each costs. You are direct but never dismissive, you ask one sharp question when the idea is unclear, and you change your mind when you are given a good reason.",
    },
  },

  // ---- Customers and sales ---------------------------------------------------
  {
    kind: "routine",
    id: "silent-deals",
    section: "customers",
    label: msg("Deals gone quiet"),
    prompt: msg(
      "Each Monday, list the open deals with no activity for thirty days: the last touch, and one follow-up line for each.",
    ),
    apps: [{ toolkit: "hubspot" }],
    needs: { connections: [["hubspot"]] },
    routine: {
      name: msg("Quiet deals"),
      sourceKind: "none",
      scheduleCron: "0 9 * * 1",
      channelKind: "email",
      instruction:
        "Each Monday, find the open deals in my connected HubSpot with no activity in the last thirty days, largest first. For each: the deal, the company, its stage, the last touch and when, and one line I could send to follow up. Only read HubSpot with the tools you have: never create, update or delete anything there.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "pre-meeting",
    section: "customers",
    label: msg("Before each outside meeting"),
    prompt: msg(
      "Each morning, for every meeting with somebody outside my team, give me five lines on their company from the web, with sources.",
    ),
    apps: [...CALENDAR_MARKS, "web"],
    needs: { connections: [CALENDAR], webSearch: true },
    routine: {
      name: msg("Before my meetings"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction:
        "Each weekday morning, read today's meetings in my connected calendar with the tools you have, and pick the ones with somebody from outside my team. For each, search the web and write five lines on their company: what it does, its size, recent news, anything that changed lately, and one thing worth asking. Give the source for every line, and say so when you could not find something rather than guessing. Only read the calendar: never accept, decline, create or change an event.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "support-triage",
    section: "customers",
    label: msg("Support triage"),
    prompt: msg(
      "Each morning, sort the support mail that arrived into urgent, normal and FYI, with draft answers from our documents where they have one.",
    ),
    apps: [...MAIL_MARKS, "knowledge"],
    needs: { connections: [MAIL] },
    routine: {
      name: msg("Support triage"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction: `Each morning, sort the support mail that arrived since yesterday into urgent, normal and FYI, urgent first. For each: who wrote (name and company, not the address), the problem in one line, and a draft answer. ${GROUNDED} ${FROM_THE_MAILBOX}`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "contacts-from-mail",
    section: "customers",
    label: msg("New people into the CRM"),
    prompt: msg(
      "Each evening, create a HubSpot contact for everyone outside my team who wrote to me for the first time today, with their company and the thread's subject.",
    ),
    apps: [...MAIL_MARKS, { toolkit: "hubspot" }],
    needs: { connections: [MAIL, ["hubspot"]], changes: ["hubspot"] },
    routine: {
      name: msg("New contacts"),
      sourceKind: "none",
      scheduleCron: "0 18 * * 1-5",
      channelKind: "email",
      instruction:
        "Each evening, read today's mail in my connected mailbox with the tools you have, and find the people outside my team who wrote to me for the first time. Only read the mailbox: never send, reply to, archive or change anything in it. Skip newsletters and automated senders. For each person not already in my connected HubSpot, create a contact with their name, email address, company, and the subject of their first thread. Then tell me who you added and who you skipped as already there. Create contacts only. Never send, reply, delete or change anything else there.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "new-booking",
    section: "customers",
    label: msg("Brief me on a new booking"),
    prompt: msg(
      "When somebody books a meeting with me, research their company and send me a short brief before it starts.",
    ),
    apps: [{ toolkit: "googlecalendar" }, "web"],
    needs: { connections: [["googlecalendar"]], webSearch: true },
    routine: {
      name: msg("New booking brief"),
      sourceKind: "none",
      // Not read: an event routine runs when its event arrives.
      scheduleCron: "0 9 * * 1",
      channelKind: "email",
      triggerKind: "event",
      event: { type: "gcal.event_created", config: {} },
      instruction:
        "A meeting was just added to my calendar. If everybody in it is from my own team, say so in one line and stop. Otherwise search the web for the company of the people from outside, and write a short brief: what the company does, its size, recent news, who is coming and their role if it can be found, and two questions worth asking. Give the source for every fact, and say so when you could not find something rather than guessing.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "agent",
    id: "support-agent",
    section: "customers",
    label: msg("A support agent"),
    prompt: msg(
      "Answer customer questions from our documents, quote the one that applies, and ask a person when it is unclear.",
    ),
    apps: ["knowledge"],
    needs: {},
    agent: {
      name: msg("Support"),
      avatar: "headset",
      persona:
        "You answer customer questions for the team, from the documents in Knowledge. Quote the document that applies and name it. Be brief and warm. When the documents do not answer the question, or a case is unclear, say so and ask a person rather than guessing, and never promise anything the documents do not.",
    },
  },

  // ---- Operations and admin --------------------------------------------------
  {
    kind: "routine",
    id: "subscriptions",
    section: "ops",
    label: msg("What we pay for every month"),
    prompt: msg(
      "On the first of each month, group the recurring charges in my receipts by vendor, and point out any price that moved.",
    ),
    apps: MAIL_MARKS,
    needs: { connections: [MAIL] },
    routine: {
      name: msg("Monthly subscriptions"),
      sourceKind: "none",
      scheduleCron: "0 9 1 * *",
      channelKind: "email",
      instruction: `On the first of each month, find the receipts and invoices for recurring charges in the last month, and group them by vendor: what it is, the amount, how often it is charged, and the date. Then list any vendor whose price differs from the month before, with both amounts, and any charge that appeared for the first time. ${FROM_THE_MAILBOX}`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "exec-summary",
    section: "ops",
    label: msg("Weekly summary from Linear and GitHub"),
    prompt: msg(
      "Each Friday, tell me what was finished in Linear and GitHub this week, the trends, and what needs my attention.",
    ),
    apps: [{ toolkit: "linear" }, { toolkit: "github" }],
    needs: { connections: [["linear"], ["github"]] },
    routine: {
      name: msg("Weekly summary"),
      sourceKind: "none",
      scheduleCron: "0 16 * * 5",
      channelKind: "email",
      instruction:
        "Each Friday, read this week's work in my connected Linear and GitHub with the tools you have: the issues completed, the pull requests merged, and what is still open and overdue. Write what was finished in a few lines grouped by project, then the trends against last week, then what needs my attention: anything blocked, overdue or waiting on a review. Only read Linear and GitHub: never create, comment on, merge or change anything there.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "issue-from-mail",
    section: "ops",
    label: msg("Bug reports into Linear"),
    prompt: msg(
      "Each morning, create a Linear issue for every mail that reports a problem with our product, with the thread's gist.",
    ),
    apps: [...MAIL_MARKS, { toolkit: "linear" }],
    needs: { connections: [MAIL, ["linear"]], changes: ["linear"] },
    routine: {
      name: msg("Bug reports"),
      sourceKind: "none",
      scheduleCron: "0 9 * * 1-5",
      channelKind: "email",
      instruction:
        "Each morning, read the mail that arrived since yesterday in my connected mailbox with the tools you have, and find the messages that report a problem with our product. Only read the mailbox: never send, reply to, archive or change anything in it. For each problem not already reported in my connected Linear, create an issue: a short title, the gist of the thread, who reported it (name and company), and the date. Then tell me the issues you created and the reports you skipped as already there. Create issues only. Never send, reply, delete or change anything else there.",
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "decisions-log",
    section: "ops",
    label: msg("A note of the week's decisions"),
    prompt: msg(
      "Each Friday, write a note into a folder of what was decided in my mail this week, and by whom.",
    ),
    apps: [...MAIL_MARKS, "knowledge"],
    needs: { connections: [MAIL] },
    routine: {
      name: msg("This week's decisions"),
      sourceKind: "none",
      scheduleCron: "0 16 * * 5",
      channelKind: "email",
      fileToFolder: true,
      instruction: `Each Friday, write a note of what was decided in my mail this week: each decision in one line, who made it, the date, and the thread it was made in. Leave out what was only discussed. If nothing was decided, say so in one line. ${FROM_THE_MAILBOX}`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "agent",
    id: "reconciler",
    section: "ops",
    label: msg("Somebody checking the numbers"),
    prompt: msg("Check figures against each other and point out what does not add up."),
    apps: ["knowledge"],
    needs: {},
    agent: {
      name: msg("Numbers"),
      avatar: "bear",
      persona:
        "You check figures against each other: totals against their lines, one report against another, this month against the last. You point out what does not add up, by how much, and where each number came from. You show your arithmetic, never round away a difference, and ask before assuming which of two numbers is the right one.",
    },
  },

  // ---- Research and insight --------------------------------------------------
  {
    kind: "routine",
    id: "competitor-watch",
    section: "insight",
    label: msg("Competitor watch"),
    prompt: msg(
      "Each Monday, open the pages I list and tell me about any price or feature change and what it means for us.",
    ),
    apps: ["browser"],
    needs: { browser: true },
    routine: {
      name: msg("Competitor watch"),
      sourceKind: "none",
      scheduleCron: "0 9 * * 1",
      channelKind: "email",
      instruction: `Each Monday, open each of these pages in the browser:

[Pages to watch: …]

Report any change to a price, a plan or a feature since last week, as far as the page itself shows it, and in one line what it means for us. If nothing changed, say so in one line. Only look: never sign up, fill in a form or buy anything.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "industry-news",
    section: "insight",
    label: msg("News that matters to us"),
    prompt: msg(
      "Each morning, search the web for news on the topics I list, one paragraph for each item that matters, with the source. Skip the rest.",
    ),
    apps: ["web"],
    needs: { webSearch: true },
    routine: {
      name: msg("Industry news"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction: `Each weekday morning, search the web for news from the last day on these topics:

[Topics: …]

Write one paragraph for each item that would change a decision we make, with its source and date. Skip the rest, and say so in one line if nothing mattered today.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "routine",
    id: "company-research",
    section: "insight",
    label: msg("Research the companies I add"),
    prompt: msg(
      "Each morning, for every new company in my Notion tracker, find their product, funding and who to talk to, with sources.",
    ),
    apps: [{ toolkit: "notion" }, "web"],
    needs: { connections: [["notion"]], webSearch: true },
    routine: {
      name: msg("Company research"),
      sourceKind: "none",
      scheduleCron: "0 8 * * 1-5",
      channelKind: "email",
      instruction: `Each weekday morning, read the companies added since yesterday to this database in my connected Notion with the tools you have:

[Tracker: …]

For each, search the web and write what they make, their latest funding, and who there to talk to, with the source for every fact; say so when something could not be found rather than guessing. Only read Notion: never create, update or delete anything there; the research comes to me.`,
      endsAfterRuns: null,
    },
  },
  {
    kind: "agent",
    id: "researcher",
    section: "insight",
    label: msg("A researcher"),
    prompt: msg(
      "Research on the web, say where each fact came from, and keep what is known apart from what is a guess.",
    ),
    apps: ["web"],
    needs: {},
    agent: {
      name: msg("Research"),
      avatar: "penguin",
      webSearch: true,
      persona:
        "You research questions on the web for the team. Every fact you give names where it came from and when. You keep what is known apart from what is a guess, and say which is which. When sources disagree you say so and show both; when you cannot find something you say that rather than fill the gap. Ask what the research is for when that would change where you look.",
    },
  },
];

/**
 * A card by id. Not `useCaseById`, which the plan called it: a name that
 * starts with `use` and a capital is a React hook to the linter, and this is
 * called in loops and plain functions.
 */
export function findUseCase(id: string): UseCase | undefined {
  return USE_CASES.find((u) => u.id === id);
}

/** The order `TemplateRequirement`s are listed in, which is the order the editor says them. */
const REQUIREMENTS: TemplateRequirement[] = ["documents", "admin", "gapReport", "enoughPeople"];

/** A routine card as the editor's template: the fields `?template=` has always filled. */
export function toRoutineTemplate(u: RoutineUseCase): RoutineTemplate {
  const { name, sourceKind, instruction, scheduleCron, channelKind } = u.routine;
  return {
    id: u.id,
    label: u.label,
    blurb: u.prompt,
    draft: { name, sourceKind, instruction, scheduleCron, channelKind },
    requires: REQUIREMENTS.filter((r) => u.needs[r] === true),
    endsAfterRuns: u.routine.endsAfterRuns,
  };
}

/**
 * The template behind `?template=<id>`: a routine card, or nothing. An old
 * `first-week` or `gap-report` link gets exactly what it always did; an agent
 * card, a scan's proposal or a retired id opens the editor empty.
 */
export function templateById(id: string): RoutineTemplate | undefined {
  const u = findUseCase(id);
  return u?.kind === "routine" ? toRoutineTemplate(u) : undefined;
}

/**
 * A group's name as a person reads it: "Gmail or Outlook". Slack is named as
 * a connected app because a workspace with only the native install has not
 * connected the Slack a card reads through.
 */
export function connectionGroupName(group: string[], t: Translate = englishT): string {
  const names = group.map((toolkit) =>
    toolkit === "slack" ? t("Slack (as a connected app)") : (TOOLKIT_NAME[toolkit] ?? toolkit),
  );
  if (names.length <= 1) return names[0] ?? "";
  return t("{{first}} or {{last}}", {
    first: names.slice(0, -1).join(", "),
    last: names[names.length - 1],
  });
}

/** The onboarding step a pick and a create are counted under. */
export function stepIdFor(id: string): string {
  return `use-case:${id}`;
}
