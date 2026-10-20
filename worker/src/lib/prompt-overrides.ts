import type { RoutineEnv } from "../types";
import type { AgentTool } from "./harness/registry";

/**
 * Prompt text a deployment has tuned, in place of what this repository ships.
 *
 * WHY THIS EXISTS. Every prompt Covan sends is in this repository —
 * `lib/prompt.ts` and each tool's `description` — and that is meant to stay
 * true: what an agent is told is part of what somebody self-hosting it can
 * read and change. But a deployment that watches its own turns learns things
 * about its own traffic, and the place it learns them is not a commit. A
 * capabilities paragraph reworded because a pilot's agents kept promising to
 * read images, a `run_tool` description tightened after a week of measured
 * calls — those are measurements of one deployment's users, and publishing
 * them would publish the users.
 *
 * So the text in git is the default, and a deployment may register a source
 * that replaces named parts of it. The open build registers none: no read, no
 * request, nothing that could fail, and every prompt is exactly the one in
 * the tree. The hosted build registers one in its own entry point, the way it
 * registers its entitlements (`lib/entitlements`).
 *
 * WHAT CAN BE REPLACED, and why that list and not "anything". A part is a
 * paragraph with one job, so a replacement is a decision about that job
 * rather than a second system prompt hiding behind the first. The persona an
 * agent's owner wrote is not on the list: that is theirs, and a deployment
 * that overrode it would be speaking in their agent's voice. The date line,
 * the document manifest and the connection manifest are not on it either —
 * they are facts about the turn, not wording.
 *
 * Never throws. A source that fails means the defaults, which is the prompt
 * every turn had before this file existed; a turn must not fail because the
 * wording could not be looked up.
 */

/** The parts of the system prefix a deployment may reword. See `buildSystemPrefix`. */
export const PROMPT_PARTS = [
  "default_persona",
  "capabilities",
  "concision",
  "brainstorm",
  "report",
  "document",
] as const;

export type PromptPart = (typeof PROMPT_PARTS)[number];

export type PromptOverrides = {
  /** Replacement text for a part of the system prefix, by name. */
  parts: Partial<Record<PromptPart, string>>;
  /** Replacement descriptions for tools, by tool name (`run_tool`). */
  tools: Partial<Record<string, string>>;
};

export type PromptSource = (env: RoutineEnv) => Promise<PromptOverrides>;

export const NO_OVERRIDES: PromptOverrides = Object.freeze({
  parts: Object.freeze({}),
  tools: Object.freeze({}),
}) as PromptOverrides;

let source: PromptSource | null = null;

export function registerPromptSource(next: PromptSource): void {
  source = next;
}

export function resetPromptSource(): void {
  source = null;
}

/** What this deployment has reworded, or nothing. Never throws. */
export async function promptOverrides(env: RoutineEnv): Promise<PromptOverrides> {
  if (!source) return NO_OVERRIDES;
  try {
    return await source(env);
  } catch (err) {
    console.error("prompt overrides could not be read; using the defaults", err);
    return NO_OVERRIDES;
  }
}

/**
 * The tools, with any description this deployment reworded.
 *
 * A copy where something changed and the same object where nothing did, so
 * the open build hands the loop exactly the tools it always had.
 */
export function withToolDescriptions(tools: AgentTool[], overrides: PromptOverrides): AgentTool[] {
  if (Object.keys(overrides.tools).length === 0) return tools;
  return tools.map((tool) => {
    const description = overrides.tools[tool.name];
    return description && description.trim() ? { ...tool, description } : tool;
  });
}
