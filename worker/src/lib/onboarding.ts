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
