import { PERSONA_TEMPLATES, type PersonaTemplate } from "./agent-meta";

/**
 * The words on screen. The ids they carry must match
 * worker/src/lib/onboarding.ts exactly — that file is what the API validates
 * against, and a rename on one side alone turns every answer into a 400.
 */
export type Option = { id: string; label: string };

export const ROLE_OPTIONS: Option[] = [
  { id: "engineering", label: "Engineering" },
  { id: "product", label: "Product" },
  { id: "design", label: "Design" },
  { id: "marketing", label: "Marketing" },
  { id: "sales", label: "Sales" },
  { id: "support", label: "Operations & Support" },
  { id: "founder", label: "Founder / Leadership" },
  { id: "other", label: "Something else" },
];

/**
 * Each use case names the persona template it starts the first agent from.
 * There are six templates in agent-meta.ts and six real answers here, which is
 * not a coincidence — this question is the template picker asked in the user's
 * words rather than ours.
 */
export type UseCaseOption = Option & { templateId: string };

export const USE_CASE_OPTIONS: UseCaseOption[] = [
  { id: "knowledge", label: "Ask the team's knowledge", templateId: "tutor" },
  { id: "support", label: "Customer support", templateId: "support" },
  { id: "code", label: "Code & technical help", templateId: "coding" },
  { id: "content", label: "Writing content", templateId: "writer" },
  { id: "marketing", label: "Marketing & launches", templateId: "gtm" },
  { id: "data", label: "Data & analysis", templateId: "analyst" },
  // Not sure yet gets the most general of the six rather than no template: a
  // filled-in first agent they can edit beats an empty form they must invent.
  { id: "unsure", label: "Not sure yet", templateId: "tutor" },
];

export const TEAM_SIZE_OPTIONS: Option[] = [
  { id: "solo", label: "Just me" },
  { id: "2-10", label: "2–10 people" },
  { id: "11-50", label: "11–50 people" },
  { id: "50+", label: "More than 50" },
];

export const REFERRAL_OPTIONS: Option[] = [
  { id: "twitter", label: "X / Twitter" },
  { id: "friend", label: "A friend or colleague" },
  { id: "search", label: "Search" },
  { id: "github", label: "GitHub" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "other", label: "Somewhere else" },
];

/** The template the first agent starts from. Falls back to the general one. */
export function templateForUseCase(useCase: string | null | undefined): PersonaTemplate {
  const option = USE_CASE_OPTIONS.find((o) => o.id === useCase);
  const fallback = PERSONA_TEMPLATES.find((t) => t.id === "tutor") ?? PERSONA_TEMPLATES[0];
  if (!option) return fallback;
  return PERSONA_TEMPLATES.find((t) => t.id === option.templateId) ?? fallback;
}
