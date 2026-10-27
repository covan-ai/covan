import { englishT, lookup, type Translate } from "@/i18n";
import { cronToShort } from "@/lib/cron-to-prose";
import { requirementReason, unmetRequirements, type TemplateFacts } from "@/lib/routine-templates";
import {
  TOOLKIT_NAME,
  connectionGroupName,
  toRoutineTemplate,
  type UseCase,
} from "@/lib/use-cases";

/**
 * What a card needs to know about the person and the workspace, read off
 * state the page already holds. Pure, so the card's words are tested without
 * a screen.
 */
export type CardFacts = TemplateFacts & {
  /** Composio toolkits with an active tool connection the person can see. */
  connected: ReadonlySet<string>;
  /** The synced sources this workspace has running (Notion, Google Drive). */
  sources: ReadonlySet<"notion" | "drive">;
  /** The agent a routine picked here would go to; null while none is known. */
  agent: { name: string; webSearch: boolean } | null;
};

export type CardState =
  /** Nothing the person can do on this page makes it work: the reason, and no button. */
  | { kind: "blocked"; reason: string }
  /**
   * It can be set up. `notes` are what is missing or worth knowing first, in
   * the order the card says them; `schedule` is when it runs, or "Agent".
   */
  | { kind: "ready"; notes: string[]; schedule: string };

const SOURCE_NAME: Record<"notion" | "drive", string> = {
  notion: "Notion",
  drive: "Google Drive",
};

/** Whether any toolkit in an any-of group is connected. */
export function groupConnected(group: string[], connected: ReadonlySet<string>): boolean {
  return group.some((toolkit) => connected.has(toolkit));
}

/**
 * A card's state for this person (spec "The page", plan B2). Blocked by the
 * first unmet requirement — only the first is written, as the editor always
 * did; otherwise ready, with the notes in a fixed order: each connection
 * group that is not satisfied, the source, each app it changes things in,
 * the browser, and web search when the agent has it off.
 */
export function cardState(u: UseCase, facts: CardFacts, given?: Translate): CardState {
  const t = given ?? englishT;
  if (u.kind === "routine") {
    const unmet = unmetRequirements(toRoutineTemplate(u), facts);
    if (unmet[0]) return { kind: "blocked", reason: lookup(t, requirementReason(unmet[0])) };
  }

  const notes: string[] = [];
  for (const group of u.needs.connections ?? []) {
    if (!groupConnected(group, facts.connected)) {
      notes.push(t("{{app}} not connected", { app: connectionGroupName(group, t) }));
    }
  }
  if (u.needs.source && !facts.sources.has(u.needs.source)) {
    notes.push(t("{{app}} not connected", { app: SOURCE_NAME[u.needs.source] }));
  }
  for (const toolkit of u.needs.changes ?? []) {
    notes.push(t("Changes things in {{app}}", { app: TOOLKIT_NAME[toolkit] ?? toolkit }));
  }
  if (u.needs.browser) notes.push(t("Uses a browser"));
  if (u.needs.webSearch && facts.agent && !facts.agent.webSearch) {
    notes.push(t("Needs web search on {{agent}}", { agent: facts.agent.name }));
  }

  return { kind: "ready", notes, schedule: scheduleOf(u, t, given) };
}

/**
 * When a card runs, in the pane's short words; "Agent" for an agent card.
 * `given` goes to `cronToShort` as it came: left out, that falls back to its
 * own English, which knows the ordinals ("1st of month").
 */
function scheduleOf(u: UseCase, t: Translate, given: Translate | undefined): string {
  if (u.kind === "agent") return t("Agent");
  const { triggerKind, endsAfterRuns, scheduleCron } = u.routine;
  if (triggerKind && triggerKind !== "schedule") return t("When it happens");
  if (endsAfterRuns !== null) {
    return t("Ends after {{count}} morning", {
      count: endsAfterRuns,
      defaultValue_other: "Ends after {{count}} mornings",
    });
  }
  return cronToShort(scheduleCron, given);
}
