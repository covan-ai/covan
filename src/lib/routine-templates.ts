import type { RoutineSourceKind } from "./routines-api";

/**
 * Three routines to start from, for somebody who has never had one.
 *
 * The create dialog has always opened on an empty box: you describe what you
 * want, a model turns it into a definition, and you confirm it. That is a good
 * second step and a poor first one — covan#45 reported it in those words, that
 * every part of the thing already worked and it "just requires the user to
 * imagine it first".
 *
 * So these are routines to pick rather than invent, and the shape is the shape
 * `PERSONA_TEMPLATES` (agent-meta.ts) and `KNOWLEDGE_TEMPLATES`
 * (knowledge-templates.ts) already use: a plain exported constant, picked by
 * id, with no React and no network in sight.
 *
 * Three decisions worth not re-deriving:
 *
 * **`draft` is nested rather than flattened.** It holds exactly the seven
 * fields the dialog's step 2 holds, in exactly the shape `runDraft` already
 * sets them from — so applying a template is the same six assignments with no
 * model call in front of them, and the two ways into step 2 stay one code path.
 *
 * **No timezone.** The browser answers it. A timezone baked in here is wrong
 * for everybody outside it.
 *
 * **`requires` is a list of tags, not a predicate.** Every fact it names is
 * already on the screen that renders the picker, which is `first-week.ts`'s
 * rule — a checklist worth one round trip is worth none. A template that
 * cannot state its requirement in these terms wants a request, and that is the
 * signal to reconsider the template.
 */
export type RoutineTemplate = {
  /** Stable, and the `?template=` value in a URL — renaming one breaks a link. */
  id: string;
  label: string;
  /** One line under the label. What arrives, not how it works. */
  blurb: string;
  emoji: string;

  /** Exactly the fields step 2 holds. */
  draft: {
    name: string;
    sourceKind: RoutineSourceKind;
    sourceUrl: string | null;
    instruction: string;
    scheduleCron: string;
    /** A hint only — the dialog resolves it to a channel id, as `runDraft` does. */
    channelKind: "email" | "slack";
  };

  requires: TemplateRequirement[];

  /**
   * Null runs until somebody stops it. A number ends the routine itself after
   * that many *delivered* runs — see 0073 for why a failed run does not count.
   */
  endsAfterRuns: number | null;
};

export type TemplateRequirement = "documents" | "admin" | "gapReport" | "enoughPeople" | "feedUrl";

/**
 * Facts the picker reads off state its screen already holds.
 *
 * `agentDocumentCount` is this agent's, not the workspace's, and that is
 * deliberate: the routines screen is scoped to one agent and the series reads
 * that agent's knowledge, so documents hung off a different agent do not make
 * this one ready.
 */
export type TemplateFacts = {
  agentDocumentCount: number;
  isAdmin: boolean;
  gapReportEnabled: boolean;
  /** Everybody in the workspace, including the person reading. */
  memberCount: number;
};

/**
 * The floor once a workspace has enough people to need one.
 *
 * Three, and not configurable, because of what the floor is for: it protects
 * members from each other. With two people, *any* reported topic tells one of
 * them about the other, and no floor can fix that — k-anonymity is impossible
 * at n=2. So a two-person workspace is told here, once, rather than receiving
 * an empty report every week forever. The template gate below blocks exactly
 * that one case — `memberCount === 2` — and nothing below it.
 *
 * A workspace of one is the other direction and is handled in the engine, not
 * here: there is nobody to protect from, so the floor is one and every gap is
 * reported. See the floor table in the spec.
 */
export const GAP_REPORT_MIN_MEMBERS = 3;

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "first-week",
    label: "Somebody's first week",
    blurb: "One note each morning for a week, from what the team has written down.",
    emoji: "🧭",
    draft: {
      name: "First week",
      sourceKind: "none",
      sourceUrl: null,
      scheduleCron: "0 9 * * *",
      channelKind: "email",
      // The curriculum, and the whole reason this series varies. The engine
      // tells the model which morning it is (0073 + executor's run position);
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
  },
  {
    id: "gap-report",
    label: "What nobody wrote down",
    blurb: "Weekly: the topics your team asked about that no document covered.",
    emoji: "📊",
    draft: {
      name: "Coverage gaps",
      sourceKind: "workspace",
      sourceUrl: null,
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
  },
  {
    id: "weekly-digest",
    label: "Weekly digest of a feed",
    blurb: "Point it at a feed or a page; once a week, what changed.",
    emoji: "📰",
    draft: {
      name: "Weekly digest",
      sourceKind: "rss",
      // Blank on purpose: this is the one field a template cannot know, and a
      // form with one field left to fill is what a template should be.
      sourceUrl: "",
      scheduleCron: "0 9 * * 1",
      channelKind: "email",
      instruction:
        "Summarise what is new since the last run. Lead with anything that changes what the team should do, name the source of each item, and skip the rest rather than padding.",
    },
    // `create-routine-dialog.tsx` has no input bound to `sourceUrl` right
    // now — main's b4f4521 removed it before this branch started, and
    // restoring it is a separate piece of work. Until then `canSave` can
    // never be satisfied for this template, so it says so here instead of
    // offering a card that leads nowhere with no explanation.
    requires: ["feedUrl"],
    endsAfterRuns: null,
  },
];

export function templateById(id: string): RoutineTemplate | undefined {
  return ROUTINE_TEMPLATES.find((t) => t.id === id);
}

/**
 * No existing exhaustiveness idiom was found elsewhere in this codebase (no
 * `assertNever`, no `: never` default) — this is the standard TypeScript
 * shape, added here because `noImplicitReturns` is off and a switch over a
 * union with no default silently returns `undefined` for a case nobody
 * added, which `unmetRequirements` would then treat as "not blocked".
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled TemplateRequirement: ${String(value)}`);
}

/** Which of a template's requirements these facts do not satisfy, in order. */
export function unmetRequirements(
  template: RoutineTemplate,
  facts: TemplateFacts,
): TemplateRequirement[] {
  return template.requires.filter((r) => {
    switch (r) {
      case "documents":
        return facts.agentDocumentCount === 0;
      case "admin":
        return !facts.isAdmin;
      case "gapReport":
        return !facts.gapReportEnabled;
      case "enoughPeople":
        // Only the two-member case: see the module docblock and
        // `askerFloor` (worker/src/lib/routines/coverage-cluster.ts) — a
        // workspace of one has nobody to protect from and the engine's floor
        // for it is already 1.
        return facts.memberCount === 2;
      case "feedUrl":
        // No fact in `TemplateFacts` decides this one — the dialog has
        // nowhere to put a `sourceUrl` for anybody, so it is unmet always,
        // not depending on workspace state.
        return true;
      default:
        return assertNever(r);
    }
  });
}

/**
 * What to say instead of offering it.
 *
 * Shown with the card rather than in place of it: hiding a template means
 * nobody learns it exists, and "an admin can turn this on" is a useful
 * sentence to read.
 */
export function requirementReason(requirement: TemplateRequirement): string {
  switch (requirement) {
    case "documents":
      return "Upload something to this agent first — the series covers what the team has written down, and there is nothing to cover yet.";
    case "admin":
      return "Only an admin of this workspace can set this one up, because it reads across conversations an admin cannot otherwise see.";
    case "gapReport":
      return "An admin has to turn the coverage report on in Settings before a routine can read it.";
    case "enoughPeople":
      return "Not available for a workspace of exactly two — any topic the report named would tell one of you about the other, and no setting changes that. One person alone is fine: there is nobody to protect from.";
    case "feedUrl":
      return "This dialog doesn't have a place to enter the feed's URL right now — that's a field waiting to come back, not a limit of this template.";
    default:
      return assertNever(requirement);
  }
}
