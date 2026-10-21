/**
 * The answers the first run will accept.
 *
 * Ids only. The words shown on screen live in src/lib/onboarding-options.ts —
 * the same split MODELS (agent-meta.ts) and OPENAI_MODELS (lib/models.ts)
 * already use, so copy can be reworded without a deploy on this side.
 *
 * Anything not on these lists is refused rather than stored. A typo would
 * otherwise sit in the table until someone wondered why a chart had a slice
 * named after a mistake.
 */

export const ROLES = [
  "engineering",
  "product",
  "design",
  "marketing",
  "sales",
  "support",
  "founder",
  "other",
] as const;

export const USE_CASES = [
  "knowledge",
  "support",
  "code",
  "content",
  "marketing",
  "data",
  "unsure",
] as const;

export const TEAM_SIZES = ["solo", "2-10", "11-50", "50+"] as const;

export const REFERRAL_SOURCES = [
  "twitter",
  "friend",
  "search",
  "github",
  "linkedin",
  "other",
] as const;

// ---- the run that introduces itself (0119) ---------------------------------

/** What the assistant is mostly for. Picks a persona template on the frontend. */
export const PURPOSES = ["sales", "operations", "marketing", "personal"] as const;

/** Whose the assistant is. `team` shares it with the workspace at `edit`. */
export const MODES = ["solo", "team"] as const;

/** What `onboarding_events` records about a step. */
export const STEP_EVENTS = ["viewed", "completed", "skipped"] as const;

/**
 * A tool the person says they use — a Composio toolkit slug, or one of our own
 * provider ids. Shape-checked rather than listed: the catalogue is a frontend
 * config over a live search of some fifteen hundred applications, and a
 * server-side list would turn every new entry into a 400 until the next
 * deploy. Lowercase alphanumerics and underscores cover every slug Composio
 * publishes (`googlecalendar`, `google_drive`, `hubspot`) and refuse anything
 * that could be markup or a path. A value nobody recognises later becomes
 * "other" in a chart, which is 0017's argument for `text` over enums.
 */
export const TOOL_SLUG = /^[a-z0-9][a-z0-9_]{0,39}$/;

/** A step id as the frontend names it: `assistant`, `tools`, `intro:apps`, … */
export const STEP_ID = /^[a-z][a-z0-9:-]{0,39}$/;

export const ASSISTANT_NAME_MAX = 120;

/** Enough for everyone's stack; past this it is not a list of tools in use. */
export const MAX_TOOLS = 12;

/** One run is a few dozen events; a batch past this is a bug, not a run. */
export const MAX_EVENTS_PER_BATCH = 50;
