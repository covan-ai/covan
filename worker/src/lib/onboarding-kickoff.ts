import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The turn that speaks first.
 *
 * Every other chat turn answers a message the person wrote. The first run ends
 * on a conversation with nothing in it, and a blank composer is the worst
 * first screen a product can have: it asks the person to invent the question
 * their new assistant is for. So the assistant opens — with what the first run
 * learned about them — and the person replies to something.
 *
 * What the model is told rides as a *volatile system note* plus one synthetic
 * user turn, built here and stored nowhere. The reply is a normal assistant
 * row, so a reload shows it; the ask is not, so the transcript never shows a
 * question nobody typed. Same shape as `lib/browser/task-note.ts`: facts read
 * fresh through the caller's own client, and a failed read is a refused
 * kickoff rather than a failed turn — the conversation is still empty and the
 * frontend shows its own card.
 */

/** What the first run recorded, in the shape the note is written from. */
export type KickoffFacts = {
  /** The person's first name, or null when the profile has none to give. */
  firstName: string | null;
  assistantName: string;
  /** In the order the person picked them. The first is the one proposed. */
  tools: string[];
  purpose: string | null;
  mode: string | null;
};

/**
 * The one user turn the model answers. Never stored: the person did not say
 * it, and a transcript that showed it would be lying about who opened.
 */
export const KICKOFF_ASK = "Introduce yourself to me now.";

/**
 * A greeting, not an essay. Well above the ~120 words the note asks for, so
 * the cap is a backstop against a model that ignores the instruction rather
 * than the thing that shapes the reply — a reply cut off mid-sentence on the
 * first screen somebody sees would be worse than a long one.
 */
export const KICKOFF_MAX_TOKENS = 1024;

/** Words for the slugs the first run's tool picker uses. */
const TOOL_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googlesheets: "Google Sheets",
  googledocs: "Google Docs",
  google_drive: "Google Drive",
  googledrive: "Google Drive",
  notion: "Notion",
  slack: "Slack",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  linear: "Linear",
  jira: "Jira",
  github: "GitHub",
  asana: "Asana",
  trello: "Trello",
  airtable: "Airtable",
  dropbox: "Dropbox",
  zendesk: "Zendesk",
  intercom: "Intercom",
  stripe: "Stripe",
  shopify: "Shopify",
  outlook: "Outlook",
  microsoftteams: "Microsoft Teams",
  whatsapp: "WhatsApp",
};

/**
 * The name a person would use for a tool slug. Anything not on the list is
 * title-cased from its slug, so an unknown one reads as a product rather than
 * an identifier.
 */
export function toolLabel(slug: string): string {
  const known = TOOL_LABELS[slug.toLowerCase()];
  if (known) return known;
  return slug
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Tools the first run lets people name before they can be connected.
 *
 * The frontend's "Connect <tool>" card skips these and shows the first tool
 * that can be connected; the proposal below is chosen the same way, so the
 * card under the greeting and the step the greeting proposes are one and the
 * same. Mirrored in the frontend's catalogue — a slug added here is added
 * there.
 */
export const NOT_YET_CONNECTABLE: ReadonlySet<string> = new Set(["whatsapp"]);

const PURPOSE_WORDS: Record<string, string> = {
  sales: "sales",
  operations: "operations",
  marketing: "marketing",
  personal: "their own work",
};

/**
 * The rules the opening is written to. A deployment may reword this paragraph
 * (`PROMPT_PARTS`, "kickoff"); the facts above it are the turn's and cannot be.
 */
export const KICKOFF_RULES =
  "Write your opening message now, in this order. Greet the person by their first name if " +
  "you have it. In one sentence, say what you are: a shared assistant for their team that has " +
  "read what the team wrote down and works inside the apps the team connects, where everyone " +
  "teaches it together and every conversation stays private to the person having it. Then " +
  "propose exactly ONE concrete next step — the one named above — in a sentence or two, and " +
  "say that you will show them the plan before you act on anything. Offer one alternative in " +
  "a single sentence. Keep the whole message under 120 words, in plain prose with no headings " +
  "and no lists. Never say or imply that any app is already connected or that you have " +
  "already read anything: nothing is connected yet.";

/**
 * The note, as Covan speaking about the person to their assistant.
 *
 * The facts are stated as facts and the proposal is chosen here rather than
 * left to the model, because the frontend puts a "Connect <tool>" card under
 * the reply built from the same first tool — the two have to agree, and only
 * one of them can be deterministic.
 */
export function kickoffNote(facts: KickoffFacts, rules: string = KICKOFF_RULES): string {
  const name = facts.firstName?.trim() || null;
  // The first tool that can be connected today, which is what the card under
  // the greeting offers. One named before its time is listed, never proposed.
  const connectable = facts.tools.find((t) => !NOT_YET_CONNECTABLE.has(t.toLowerCase()));
  const first = connectable ? toolLabel(connectable) : null;
  const notYet = facts.tools.filter((t) => NOT_YET_CONNECTABLE.has(t.toLowerCase()));
  const purpose = facts.purpose ? (PURPOSE_WORDS[facts.purpose] ?? facts.purpose) : null;
  const lines = [
    "This is the first message of a brand-new conversation. The person has just finished " +
      "setting you up and has not written anything yet; you are opening. This is Covan's own " +
      "record of their setup, not something they wrote:",
    `- Their first name: ${name ?? "unknown — greet them without a name"}.`,
    `- Your name: ${facts.assistantName}.`,
    `- What they said you will mostly help with: ${purpose ?? "not stated"}.`,
    `- Who you work for: ${facts.mode === "team" ? "their team — teammates will use you too" : facts.mode === "solo" ? "them alone" : "not stated"}.`,
    facts.tools.length > 0
      ? `- The apps they said they use, in the order they picked them: ${facts.tools.map(toolLabel).join(", ")}. None is connected yet.`
      : "- They did not name any apps they use.",
    ...(notYet.length > 0
      ? [
          `- Not available in Covan yet: ${notYet.map(toolLabel).join(", ")}. Say so in one clause and do not propose connecting ${notYet.length === 1 ? "it" : "them"}.`,
        ]
      : []),
    first
      ? `- The one next step to propose: connecting ${first}, and the first useful thing you would do with it once they have.`
      : "- The one next step to propose: adding one document the team relies on, so your first answers come from it rather than from general knowledge.",
    "",
    rules,
  ];
  return lines.join("\n");
}

const ONBOARDING_COLUMNS = "completed_at, assistant_name, tools, purpose, mode, agent_id";

type OnboardingRow = {
  completed_at?: unknown;
  assistant_name?: unknown;
  tools?: unknown;
  purpose?: unknown;
  mode?: unknown;
  agent_id?: unknown;
};

function firstWord(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const word = name.trim().split(/\s+/)[0];
  return word || null;
}

/**
 * The note and the ask for this person's first conversation with this agent,
 * or null when there is none to open: the first run is not finished, or it
 * made some other agent, or the read failed. Null is a refused kickoff — the
 * conversation stays empty and the frontend shows its own card — never a turn
 * with a made-up opening.
 *
 * Read through the caller's own client: `user_onboarding` is readable by its
 * own row's owner and nobody else (0017), which is the whole guard — a person
 * can only open a conversation the first run made *for them*.
 */
export async function onboardingKickoff(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  rules?: string,
): Promise<{ note: string; ask: string } | null> {
  try {
    const { data, error } = await db
      .from("user_onboarding")
      .select(ONBOARDING_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.warn("could not read the first run for its opening turn", error.code);
      return null;
    }
    const row = (data ?? null) as OnboardingRow | null;
    if (!row || !row.completed_at || row.agent_id !== agentId) return null;
    const assistantName =
      typeof row.assistant_name === "string" && row.assistant_name.trim()
        ? row.assistant_name.trim()
        : null;
    if (!assistantName) return null;

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("name")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) {
      // A greeting without a name is still a greeting; the read above is the
      // one that decides whether there is a turn to run.
      console.warn("could not read the person's name for the opening turn", profileError.code);
    }

    const tools = Array.isArray(row.tools)
      ? row.tools.filter((t): t is string => typeof t === "string" && t.length > 0)
      : [];
    const facts: KickoffFacts = {
      firstName: firstWord((profile as { name?: unknown } | null)?.name),
      assistantName,
      tools,
      purpose: typeof row.purpose === "string" ? row.purpose : null,
      mode: typeof row.mode === "string" ? row.mode : null,
    };
    return { note: kickoffNote(facts, rules), ask: KICKOFF_ASK };
  } catch {
    console.warn("could not read the first run for its opening turn");
    return null;
  }
}
