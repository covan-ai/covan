import type { LucideIcon } from "lucide-react";
import { BookOpen, Briefcase, ClipboardList, Megaphone, User, Users } from "lucide-react";
import type { ProviderId } from "./connections-api";
import { EMOJIS, PERSONA_TEMPLATES, type PersonaTemplate } from "./agent-meta";
import type { FirstWeekStep } from "./first-week";
import type { OnboardingAnswers } from "./onboarding-flow";

/**
 * Everything the first run says, in the order it says it.
 *
 * One file on purpose: the screens, their copy, the options on each, the three
 * ready-made assistants, the tool catalogue and the setup list after it are all
 * here, so a change of wording or order is an edit to this file and nothing
 * else. The components under `components/welcome/` draw what they are handed;
 * the flow engine (`onboarding-flow.ts`) walks `STEPS` and knows nothing about
 * what a step contains.
 *
 * The ids here are the ids the API stores (`worker/src/lib/onboarding.ts`
 * validates `purpose`, `mode` and the shape of a tool slug), so a rename on
 * one side alone turns every answer into a 400.
 */

export type SectionId = "meet" | "personalise" | "start";

/** Which of the four looping demos an intro screen shows (`mini-demos.tsx`). */
export type DemoKind = "documents" | "apps" | "schedule" | "team";

export type IntroScreen = {
  id: string;
  /**
   * The headline, in three pieces so exactly one phrase can carry the brand
   * colour. `before` and `after` may be empty; `brand` never is.
   */
  headline: { before: string; brand: string; after: string };
  /** One muted line under it: what it means, or why it can be trusted. */
  line: string;
  demo: DemoKind;
};

export type Emoji = (typeof EMOJIS)[number];

/**
 * A ready-made assistant: a name, a face and the persona template behind it.
 * Picking one fills the name and emoji; the person can still edit both.
 */
export type RoleSuggestion = {
  id: string;
  name: string;
  emoji: Emoji;
  line: string;
  templateId: string;
};

/** Where a tool's mark comes from: fetched through our logo proxy, or drawn by us. */
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
  /** What connecting it gives the assistant, in a few words. */
  line: string;
  /**
   * The slug the connected-apps list (`connected-apps.ts`) reports it under
   * once it is connected, so the setup card can tell when it is.
   */
  connectedSlug: string;
};

export type PurposeId = "sales" | "operations" | "marketing" | "personal";

export type PurposeOption = {
  id: PurposeId;
  label: string;
  line: string;
  templateId: string;
  icon: LucideIcon;
};

export type ModeId = "solo" | "team";

export type ModeOption = { id: ModeId; label: string; line: string; icon: LucideIcon };

export type PersonaliseStepId = "assistant" | "tools" | "purpose" | "mode" | "team";

export type PersonaliseStep = {
  id: PersonaliseStepId;
  title: string;
  subtitle?: string;
  /** The label of the skip link. Absent means the step cannot be skipped. */
  skip?: string;
  /** When the step is part of the run at all. Absent means always. */
  when?: (answers: OnboardingAnswers) => boolean;
  /** Whether a cold return can consider this step dealt with. */
  answered: (answers: OnboardingAnswers) => boolean;
};

/** The things on the page a coach mark can point at (`data-coach="…"`). */
export type CoachTargetId =
  | "composer"
  | "attach"
  | "kickoff-card"
  | "integrations-catalogue"
  | "invite-member"
  | "new-routine"
  | "share-agent";

/** The page a coach target lives on, so "Try" can go there first. */
export type CoachRoute = "chat" | "integrations" | "members" | "routines";

export type CoachTarget = { id: CoachTargetId; title: string; hint: string; route: CoachRoute };

export type SetupContext = {
  /** The first tool the person named that can be connected, by name. */
  toolName: string | null;
  mode: ModeId | null;
};

export type SetupStepConfig = {
  key: FirstWeekStep["key"];
  label: (ctx: SetupContext) => string;
  hint: (ctx: SetupContext) => string;
  coach: (ctx: SetupContext) => CoachTarget;
  /**
   * Finishing it is rewarded with credits on a hosted install. The list says
   * so without a number, because the number is the hosted build's to state.
   */
  rewarded?: boolean;
};

// ---- the words ----------------------------------------------------------------

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "meet", label: "Meet" },
  { id: "personalise", label: "Personalise" },
  { id: "start", label: "Start" },
];

export const INTRO: IntroScreen[] = [
  {
    id: "documents",
    headline: { before: "Answers from", brand: "your own", after: "documents" },
    line: "Every reply names the file it came from.",
    demo: "documents",
  },
  {
    id: "apps",
    headline: { before: "Works", brand: "inside", after: "the apps you already use" },
    line: "Reads and acts in the tools you connect, and only with your say-so.",
    demo: "apps",
  },
  {
    id: "schedule",
    headline: { before: "Runs", brand: "while", after: "you're not looking" },
    line: "Give it a routine and it reports back.",
    demo: "schedule",
  },
  {
    id: "team",
    headline: { before: "One assistant,", brand: "private", after: "to each of you" },
    line: "Everyone trains it together. Every conversation stays yours.",
    demo: "team",
  },
];

export const ROLES: RoleSuggestion[] = [
  {
    id: "desk",
    name: "Desk",
    emoji: "🧭",
    line: "Keeps the team's answers in one place.",
    templateId: "tutor",
  },
  {
    id: "scout",
    name: "Scout",
    emoji: "📊",
    line: "Finds and summarises what's out there.",
    templateId: "analyst",
  },
  {
    id: "quill",
    name: "Quill",
    emoji: "✍️",
    line: "Drafts in your voice.",
    templateId: "writer",
  },
];

/** The role id stored when the person typed a name of their own. */
export const CUSTOM_ROLE = "custom";

/** The role id stored when the person kept the default, "<Name>'s assistant". */
export const DEFAULT_ROLE = "default";

/** The emoji a fresh assistant starts with, before anyone picks one. */
export const DEFAULT_EMOJI: Emoji = "🧭";

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
    line: "Pages and databases",
    connectedSlug: "notion",
  },
  {
    id: "google_drive",
    name: "Google Drive",
    logo: { kind: "provider", provider: "google_drive" },
    connect: { kind: "provider", provider: "google_drive" },
    keywords: ["drive", "gdrive", "files"],
    line: "Docs, Sheets and files",
    connectedSlug: "googledrive",
  },
  {
    id: "slack",
    name: "Slack",
    logo: { kind: "slack" },
    connect: { kind: "slack" },
    keywords: ["chat", "channels"],
    line: "Channels and messages",
    connectedSlug: "slack",
  },
  composio("gmail", "Gmail", "Mail and drafts", ["email", "google"]),
  composio("googlecalendar", "Google Calendar", "Events and availability", ["calendar", "google"]),
  composio("googlesheets", "Google Sheets", "Spreadsheets", ["sheets", "google", "excel"]),
  composio("googledocs", "Google Docs", "Documents", ["docs", "google"]),
  composio("hubspot", "HubSpot", "Contacts, deals and tickets", ["crm"]),
  composio("salesforce", "Salesforce", "Leads, accounts and opportunities", ["crm"]),
  composio("linear", "Linear", "Issues and projects", ["tickets"]),
  composio("jira", "Jira", "Issues and boards", ["atlassian", "tickets"]),
  composio("github", "GitHub", "Repositories, issues and pull requests", ["git", "code"]),
  composio("asana", "Asana", "Tasks and projects"),
  composio("trello", "Trello", "Boards and cards", ["kanban"]),
  composio("airtable", "Airtable", "Bases and records", ["database"]),
  composio("dropbox", "Dropbox", "Files and folders"),
  composio("zendesk", "Zendesk", "Tickets and customers", ["support", "helpdesk"]),
  composio("intercom", "Intercom", "Conversations and contacts", ["support", "chat"]),
  composio("stripe", "Stripe", "Payments, customers and invoices", ["billing"]),
  composio("shopify", "Shopify", "Orders, products and customers", ["store", "ecommerce"]),
  composio("outlook", "Outlook", "Mail and calendar", ["email", "microsoft"]),
  composio("microsoftteams", "Microsoft Teams", "Chats and channels", ["teams", "microsoft"]),
  {
    // Named so the answer is recorded; nothing offers to connect it yet. The
    // kickoff turn knows the same (`NOT_YET_CONNECTABLE` on the worker).
    id: "whatsapp",
    name: "WhatsApp",
    logo: { kind: "composio", slug: "whatsapp" },
    connect: { kind: "none" },
    keywords: ["messaging", "meta"],
    line: "Not available yet",
    connectedSlug: "whatsapp",
  },
];

export const PURPOSES: PurposeOption[] = [
  {
    id: "sales",
    label: "Sales",
    line: "Leads, follow-ups, proposals.",
    templateId: "sales",
    icon: Briefcase,
  },
  {
    id: "operations",
    label: "Operations",
    line: "Processes, handoffs, the questions that repeat.",
    templateId: "operations",
    icon: ClipboardList,
  },
  {
    id: "marketing",
    label: "Marketing",
    line: "Positioning, content, launches.",
    templateId: "gtm",
    icon: Megaphone,
  },
  {
    id: "personal",
    label: "My own work",
    line: "Notes, research, writing.",
    templateId: "tutor",
    icon: BookOpen,
  },
];

export const MODES: ModeOption[] = [
  {
    id: "solo",
    label: "Just me",
    line: "The assistant and its conversations are yours alone.",
    icon: User,
  },
  {
    id: "team",
    label: "My team",
    line: "Teammates can use and train it. Every conversation stays private.",
    icon: Users,
  },
];

export const STEPS: PersonaliseStep[] = [
  {
    id: "assistant",
    title: "Name your assistant",
    subtitle: "You can change this any time.",
    answered: (a) => a.assistantName !== null,
  },
  {
    id: "tools",
    title: "Which tools do you use?",
    subtitle: "Nothing connects yet. This tells your assistant where to start.",
    skip: "Skip for now",
    answered: (a) => a.tools !== null,
  },
  {
    id: "purpose",
    title: "What will it mostly do?",
    answered: (a) => a.purpose !== null,
  },
  {
    id: "mode",
    title: "Just you, or the team?",
    answered: (a) => a.mode !== null,
  },
  {
    id: "team",
    title: "Set up the team",
    subtitle: "One assistant for everyone: shared knowledge, private conversations.",
    when: (a) => a.mode === "team",
    answered: () => false,
  },
];

export const CTA = {
  continue: "Continue",
  skip: "Skip for now",
  skipIntro: "Skip intro",
  back: "Back",
  finish: "Meet my assistant",
  finishing: "Setting up…",
  gotIt: "Got it",
  try: "Try",
} as const;

/**
 * The setup list beside the first conversation. Each entry is joined by `key`
 * to the done-state `first-week.ts` derives, so the list never claims a step
 * is done that the data does not back.
 */
export const SETUP: SetupStepConfig[] = [
  {
    key: "ask",
    label: () => "Ask your first question",
    hint: () => "Anything at all. The reply names where it came from.",
    coach: () => ({
      id: "composer",
      title: "Ask here",
      hint: "Type a question and press Enter. Shift+Enter adds a line.",
      route: "chat",
    }),
  },
  {
    key: "connect",
    label: ({ toolName }) => (toolName ? `Connect ${toolName}` : "Connect an app"),
    hint: ({ toolName }) =>
      toolName
        ? `Your assistant can then read and act in ${toolName}, with your say-so.`
        : "Your assistant can then read and act in it, with your say-so.",
    coach: () => ({
      id: "integrations-catalogue",
      title: "Connect an app",
      hint: "Pick one. You sign in with the app itself; nothing is shared with anyone else.",
      route: "integrations",
    }),
  },
  {
    key: "knowledge",
    label: () => "Add a document",
    hint: () => "A process doc, a contract, a research note. Answers start coming from it.",
    coach: () => ({
      id: "attach",
      title: "Attach a document",
      hint: "Drop a file here or pick one. It is read once and quoted after that.",
      route: "chat",
    }),
    rewarded: true,
  },
  {
    key: "team",
    label: ({ mode }) => (mode === "solo" ? "Share the assistant" : "Invite a teammate"),
    hint: ({ mode }) =>
      mode === "solo"
        ? "Let someone else use it. Their conversations with it stay their own."
        : "They get everything the assistant knows. Their conversations stay their own.",
    coach: ({ mode }) =>
      mode === "solo"
        ? {
            id: "share-agent",
            title: "Share it",
            hint: "Choose who can use the assistant and who can train it.",
            route: "chat",
          }
        : {
            id: "invite-member",
            title: "Invite someone",
            hint: "An email is enough. They join the workspace and see the shared assistant.",
            route: "members",
          },
  },
  {
    key: "routine",
    label: () => "Schedule a routine",
    hint: () => "Something that runs on its own and reports back.",
    coach: () => ({
      id: "new-routine",
      title: "New routine",
      hint: "Say what to do and how often. The result arrives by email or Slack.",
      route: "routines",
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

/** Name and keywords, case-insensitively. An empty query is the whole grid. */
export function searchTools(query: string): ToolEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return TOOLS;
  return TOOLS.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.id.includes(q) ||
      t.keywords.some((k) => k.toLowerCase().includes(q)),
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

function templateById(id: string | null | undefined): PersonaTemplate | undefined {
  return id ? PERSONA_TEMPLATES.find((t) => t.id === id) : undefined;
}

/**
 * The persona the assistant starts from: the ready-made role's if one was
 * picked, else the purpose's, else the most general template there is.
 */
export function templateFor(answers: {
  purpose: string | null;
  assistantRole: string | null;
}): PersonaTemplate {
  const role = ROLES.find((r) => r.id === answers.assistantRole);
  const purpose = PURPOSES.find((p) => p.id === answers.purpose);
  return (
    templateById(role?.templateId) ??
    templateById(purpose?.templateId) ??
    templateById("tutor") ??
    PERSONA_TEMPLATES[0]
  );
}

/** "Ada's assistant", or "Your assistant" when the profile has no name. */
export function defaultAssistantName(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return name ? `${name}'s assistant` : "Your assistant";
}
