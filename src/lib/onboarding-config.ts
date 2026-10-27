import { englishT, msg, type Translate } from "@/i18n";
import type { ProviderId } from "./connections-api";
import type { FirstWeekStep } from "./first-week";

export type ToolLogo =
  | { kind: "composio"; slug: string }
  | { kind: "provider"; provider: ProviderId }
  | { kind: "slack" };

/**
 * How a tool is connected once the person is in the app. `none` is a tool we
 * cannot connect yet: it can still be named — the intent is the point of the
 * question — but nothing offers to connect it.
 */
export type ToolConnect =
  | { kind: "composio"; slug: string }
  | { kind: "provider"; provider: ProviderId }
  | { kind: "slack" }
  | { kind: "none" };

export type ToolEntry = {
  /** Stored in `user_onboarding.tools`. Lowercase, `[a-z0-9_]`. */
  id: string;
  name: string;
  logo: ToolLogo;
  connect: ToolConnect;
  /** Other words people search by. The name is always searched. */
  keywords: string[];
  /** What connecting it gives the assistant, in a few words. An English key: `lookup(t, tool.line)`. */
  line: string;
  /**
   * The slug the connected-apps list (`connected-apps.ts`) reports it under
   * once it is connected, so the setup card can tell when it is.
   */
  connectedSlug: string;
};

export type CoachTargetId =
  | "composer"
  | "attach"
  | "kickoff-card"
  | "integrations-catalogue"
  | "invite-member"
  | "new-routine"
  | "share-agent"
  | "use-case-card";

/** The page a coach target lives on, so "Try" can go there first. */
export type CoachRoute = "chat" | "integrations" | "members" | "routines" | "use-cases";

/** `title` and `hint` are English keys: `lookup(t, target.title)` where they are drawn. */
export type CoachTarget = { id: CoachTargetId; title: string; hint: string; route: CoachRoute };

export type SetupContext = {
  /** The first tool the person named that can be connected, by name. */
  toolName: string | null;
  mode: "solo" | "team" | null;
};

export type SetupStepConfig = {
  key: FirstWeekStep["key"];
  /** Written in the caller's language when it passes its `t`; English otherwise. */
  label: (ctx: SetupContext, t?: Translate) => string;
  hint: (ctx: SetupContext, t?: Translate) => string;
  coach: (ctx: SetupContext) => CoachTarget;
  /**
   * Finishing it is rewarded with credits on a hosted install. The list says
   * so without a number, because the number is the hosted build's to state.
   */
  rewarded?: boolean;
};

// ---- the words ----------------------------------------------------------------

const composio = (
  slug: string,
  name: string,
  line: string,
  keywords: string[] = [],
): ToolEntry => ({
  id: slug,
  name,
  logo: { kind: "composio", slug },
  connect: { kind: "composio", slug },
  keywords,
  line,
  connectedSlug: slug,
});

/**
 * The tools offered on the second screen. Curated rather than the whole
 * Composio catalogue: a grid of twenty-odd marks is a question; a search over
 * fifteen hundred is a chore. Anyone whose tool is missing can say so from the
 * empty search result.
 *
 * Order is the grid order. The first three are the ones we hold marks for.
 */
export const TOOLS: ToolEntry[] = [
  {
    id: "notion",
    name: "Notion",
    logo: { kind: "provider", provider: "notion" },
    connect: { kind: "provider", provider: "notion" },
    keywords: ["wiki", "pages", "docs"],
    line: msg("Pages and databases"),
    connectedSlug: "notion",
  },
  {
    id: "google_drive",
    name: "Google Drive",
    logo: { kind: "provider", provider: "google_drive" },
    connect: { kind: "provider", provider: "google_drive" },
    keywords: ["drive", "gdrive", "files"],
    line: msg("Docs, Sheets and files"),
    connectedSlug: "googledrive",
  },
  {
    id: "slack",
    name: "Slack",
    logo: { kind: "slack" },
    connect: { kind: "slack" },
    keywords: ["chat", "channels"],
    line: msg("Channels and messages"),
    connectedSlug: "slack",
  },
  composio("gmail", "Gmail", msg("Mail and drafts"), ["email", "google"]),
  composio("googlecalendar", "Google Calendar", msg("Events and availability"), [
    "calendar",
    "google",
  ]),
  composio("googlesheets", "Google Sheets", msg("Spreadsheets"), ["sheets", "google", "excel"]),
  composio("googledocs", "Google Docs", msg("Documents"), ["docs", "google"]),
  composio("hubspot", "HubSpot", msg("Contacts, deals and tickets"), ["crm"]),
  composio("salesforce", "Salesforce", msg("Leads, accounts and opportunities"), ["crm"]),
  composio("linear", "Linear", msg("Issues and projects"), ["tickets"]),
  composio("jira", "Jira", msg("Issues and boards"), ["atlassian", "tickets"]),
  composio("github", "GitHub", msg("Repositories, issues and pull requests"), ["git", "code"]),
  composio("asana", "Asana", msg("Tasks and projects")),
  composio("trello", "Trello", msg("Boards and cards"), ["kanban"]),
  composio("airtable", "Airtable", msg("Bases and records"), ["database"]),
  composio("dropbox", "Dropbox", msg("Files and folders")),
  composio("zendesk", "Zendesk", msg("Tickets and customers"), ["support", "helpdesk"]),
  composio("intercom", "Intercom", msg("Conversations and contacts"), ["support", "chat"]),
  composio("stripe", "Stripe", msg("Payments, customers and invoices"), ["billing"]),
  composio("shopify", "Shopify", msg("Orders, products and customers"), ["store", "ecommerce"]),
  composio("outlook", "Outlook", msg("Mail and calendar"), ["email", "microsoft"]),
  composio("microsoftteams", "Microsoft Teams", msg("Chats and channels"), ["teams", "microsoft"]),
  {
    // Named so the answer is recorded; nothing offers to connect it yet. The
    // kickoff turn knows the same (`NOT_YET_CONNECTABLE` on the worker).
    id: "whatsapp",
    name: "WhatsApp",
    logo: { kind: "composio", slug: "whatsapp" },
    connect: { kind: "none" },
    keywords: ["messaging", "meta"],
    line: msg("Not available yet"),
    connectedSlug: "whatsapp",
  },
];

/** English keys: `lookup(t, CTA.continue)` where they are drawn. */
export const CTA = {
  continue: msg("Continue"),
  skip: msg("Skip for now"),
  back: msg("Back"),
  finishing: msg("Setting up…"),
  gotIt: msg("Got it"),
  try: msg("Try"),
} as const;

/**
 * "What should it do?" (A14): the jobs a first agent is set up for, as chips.
 * Each carries the sentence it adds to the persona, so the persona under the
 * chips is written from the choices and reads like one paragraph. The label is
 * an English key (`lookup(t, job.label)`); the sentence is the agent's system
 * prompt and stays English on purpose.
 */
export const JOBS = [
  {
    id: "answer-questions",
    label: msg("Answer customer questions"),
    sentence: "answer customer questions using the documents in Knowledge",
  },
  {
    id: "draft-replies",
    label: msg("Draft replies"),
    sentence: "draft replies for the team to check and send",
  },
  {
    id: "summarise",
    label: msg("Summarise documents"),
    sentence: "summarise long documents into what matters",
  },
  {
    id: "watch-mailbox",
    label: msg("Watch a mailbox"),
    sentence: "keep an eye on a shared mailbox and say what needs a person",
  },
  {
    id: "research",
    label: msg("Research the web"),
    sentence: "research questions on the web and say where each fact came from",
  },
  {
    id: "reconcile",
    label: msg("Reconcile numbers"),
    sentence: "check figures against each other and point out what does not add up",
  },
] as const;

export type JobId = (typeof JOBS)[number]["id"];

/**
 * The persona a first agent starts from, written from its name, the
 * workspace and the jobs picked: who it works for, what it does, how it
 * speaks and when it asks. Editable on the same screen, and later in
 * Configuration.
 */
export function personaFor(input: {
  workspaceName: string | null;
  jobs: readonly string[];
}): string {
  const team = input.workspaceName?.trim() || "the team";
  const sentences = JOBS.filter((j) => input.jobs.includes(j.id)).map((j) => j.sentence);
  const what =
    sentences.length === 0
      ? `help ${team} with whatever it asks, using the documents in Knowledge`
      : sentences.length === 1
        ? sentences[0]
        : `${sentences.slice(0, -1).join(", ")} and ${sentences.at(-1)}`;
  return (
    `You work for ${team}. You ${what}. ` +
    "Be brief and warm, quote the document that applies, and ask a person when a case is unclear rather than guessing."
  );
}

/**
 * The setup list beside the first conversation. Each entry is joined by `key`
 * to the done-state `first-week.ts` derives, so the list never claims a step
 * is done that the data does not back.
 */
export const SETUP: SetupStepConfig[] = [
  {
    key: "ask",
    label: (_ctx, t = englishT) => t("Ask your first question"),
    hint: (_ctx, t = englishT) => t("Anything at all. The reply names where it came from."),
    coach: () => ({
      id: "composer",
      title: msg("Ask here"),
      hint: msg("Type a question and press Enter. Shift+Enter adds a line."),
      route: "chat",
    }),
  },
  {
    key: "connect",
    label: ({ toolName }, t = englishT) =>
      toolName ? t("Connect {{toolName}}", { toolName }) : t("Connect an app"),
    hint: ({ toolName }, t = englishT) =>
      toolName
        ? t("Your assistant can then read and act in {{toolName}}, with your say-so.", { toolName })
        : t("Your assistant can then read and act in it, with your say-so."),
    coach: () => ({
      id: "integrations-catalogue",
      title: msg("Connect an app"),
      hint: msg("Pick one. You sign in with the app itself; nothing is shared with anyone else."),
      route: "integrations",
    }),
  },
  {
    key: "knowledge",
    label: (_ctx, t = englishT) => t("Add a document"),
    hint: (_ctx, t = englishT) =>
      t("A process doc, a contract, a research note. Answers start coming from it."),
    coach: () => ({
      id: "attach",
      title: msg("Attach a document"),
      hint: msg("Drop a file here or pick one. It is read once and quoted after that."),
      route: "chat",
    }),
    rewarded: true,
  },
  {
    key: "team",
    label: ({ mode }, t = englishT) =>
      mode === "solo" ? t("Share the assistant") : t("Invite a teammate"),
    hint: ({ mode }, t = englishT) =>
      mode === "solo"
        ? t("Let someone else use it. Their conversations with it stay their own.")
        : t("They get everything the assistant knows. Their conversations stay their own."),
    coach: ({ mode }) =>
      mode === "solo"
        ? {
            id: "share-agent",
            title: msg("Share it"),
            hint: msg("Choose who can use the assistant and who can train it."),
            route: "chat",
          }
        : {
            id: "invite-member",
            title: msg("Invite someone"),
            hint: msg("An email is enough. They join the workspace and see the shared assistant."),
            route: "members",
          },
  },
  {
    key: "routine",
    label: (_ctx, t = englishT) => t("Schedule a routine"),
    hint: (_ctx, t = englishT) => t("Something that runs on its own and reports back."),
    // The use cases rather than the empty editor: somebody at this step has
    // not yet decided what a routine of theirs would do.
    coach: () => ({
      id: "use-case-card",
      title: msg("Pick a routine"),
      hint: msg("Each card is a routine ready to set up. Nothing runs until you create it."),
      route: "use-cases",
    }),
  },
];

// ---- helpers ------------------------------------------------------------------

/**
 * Where a Composio toolkit's mark is fetched from: our own logo proxy, which
 * only fetches from Composio's two logo hosts (`GET /composio/logo`). The same
 * address the Integrations page builds from a toolkit response.
 */
export function composioLogoPath(slug: string): string {
  return `/composio/logo?u=${encodeURIComponent(`https://logos.composio.dev/api/${slug}`)}`;
}

export function toolById(id: string): ToolEntry | undefined {
  return TOOLS.find((t) => t.id === id);
}

/**
 * Name and keywords, case-insensitively, in the language the query was typed
 * in. An empty query is the whole grid.
 */
export function searchTools(query: string, locale: string = "en"): ToolEntry[] {
  const q = query.trim().toLocaleLowerCase(locale);
  if (!q) return TOOLS;
  return TOOLS.filter(
    (tool) =>
      tool.name.toLocaleLowerCase(locale).includes(q) ||
      tool.id.includes(q) ||
      tool.keywords.some((k) => k.toLocaleLowerCase(locale).includes(q)),
  );
}

/**
 * The tool the first conversation offers to connect: the first one the person
 * named, in their order, that can be connected and is not connected already.
 * The kickoff turn on the worker proposes the same one, by the same rule.
 */
export function firstConnectableTool(
  ids: readonly string[] | null | undefined,
  connectedSlugs: ReadonlySet<string> = new Set(),
): ToolEntry | null {
  for (const id of ids ?? []) {
    const tool = toolById(id);
    if (!tool || tool.connect.kind === "none") continue;
    if (connectedSlugs.has(tool.connectedSlug)) continue;
    return tool;
  }
  return null;
}

/** "Ada's assistant", or "Your assistant" when the profile has no name. */
export function defaultAssistantName(
  firstName: string | null | undefined,
  t: Translate = englishT,
): string {
  const name = firstName?.trim();
  return name ? t("{{name}}'s assistant", { name }) : t("Your assistant");
}
