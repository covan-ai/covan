import { msg } from "@/i18n";
import type { CreatableSourceKind } from "./routines-api";

/**
 * The shape of a routine to start from, and the proposals a scan makes.
 *
 * The create dialog has always opened on an empty box: you describe what you
 * want, a model turns it into a definition, and you confirm it. That is a good
 * second step and a poor first one — covan#45 reported it in those words, that
 * every part of the thing already worked and it "just requires the user to
 * imagine it first".
 *
 * So these are routines to pick rather than invent, and the shape is the shape
 * `KNOWLEDGE_TEMPLATES`
 * (knowledge-templates.ts) already uses: a plain exported constant, picked by
 * id, with no React and no network in sight.
 *
 * Three decisions worth not re-deriving:
 *
 * **`draft` is nested rather than flattened.** It holds the fields the
 * dialog's step 2 holds, in exactly the shape `runDraft` already sets them
 * from — so applying a template is the same assignments with no model call in
 * front of them, and the two ways into step 2 stay one code path.
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
  /** A key (`msg`): drawn with `lookup(t, …)`. */
  label: string;
  /** One line under the label. What arrives, not how it works. A key, like `label`. */
  blurb: string;

  /** Exactly the fields step 2 holds. */
  draft: {
    /** A key (`msg`): the editor fills its Name field with `lookup(t, …)`. */
    name: string;
    sourceKind: CreatableSourceKind;
    instruction: string;
    scheduleCron: string;
    /** A hint only — the dialog resolves it to a channel id, as `runDraft` does. */
    channelKind: "email" | "slack";
  };

  requires: TemplateRequirement[];

  /**
   * Null runs until somebody stops it. A number ends the routine itself after
   * that many *delivered* runs — see 0074 for why a failed run does not count.
   */
  endsAfterRuns: number | null;
};

export type TemplateRequirement = "documents" | "admin" | "gapReport" | "enoughPeople";

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

// The two general templates that used to live here (`first-week`,
// `gap-report`) and `templateById` moved to `use-cases.ts`, where every
// routine a person can start from is listed in one catalogue. What stays
// here is the shape, the requirement model, and the scan's proposals.

/**
 * What every proposal's instruction says about the mailbox, once.
 *
 * The routine runs as its owner and reaches their own connected mailbox and
 * calendar through the tools a scheduled run already has (`find_tool`,
 * `run_tool`); nothing here names an operation, because which one depends on
 * whether the person connected Gmail or Outlook.
 */
export const FROM_THE_MAILBOX =
  "Read it from my connected mailbox and calendar with the tools you have. Never send, reply to, archive or change anything there — this is a digest for me to read.";

/**
 * The routines a scan of what arrived proposes (spec: "Proposals"), one per
 * kind that is worth one. Kept out of `USE_CASES` as they are: each names
 * its bucket through `{label}`, which only the report can fill
 * (`fillTemplate`), so none of them may open from a bare `?template=` link.
 * The catalogue's six inbox cards are these with the kind's plain name
 * filled in.
 *
 * All scheduled, none event-triggered: a per-mail trigger is one run per mail,
 * and a mailbox that receives five hundred threads a month would spend an
 * order of magnitude more than a morning digest.
 */
export const ARRIVAL_TEMPLATES: RoutineTemplate[] = [
  {
    id: "arrivals-questions",
    label: msg("Questions waiting on you"),
    blurb: msg(
      "Each morning: the questions that arrived since yesterday, each with a draft reply from what your team has written down.",
    ),
    draft: {
      name: msg("Questions waiting on me"),
      sourceKind: "none",
      scheduleCron: "0 9 * * *",
      channelKind: "email",
      instruction: `Each morning, list the questions people outside my team sent me since yesterday that I have not answered yet — mostly "{label}". For each: who it is from (name and company, not the address), the question in one line, and a short draft reply grounded in what my team has written down, naming the document it came from. If the documents do not answer it, say so instead of guessing. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
  {
    id: "arrivals-requests",
    label: msg("What is waiting on your decision"),
    blurb: msg(
      "Each morning: what is waiting on a decision or an approval from you, oldest first.",
    ),
    draft: {
      name: msg("Waiting on my decision"),
      sourceKind: "none",
      scheduleCron: "0 9 * * *",
      channelKind: "email",
      instruction: `Each morning, list what is waiting on a decision, an approval or an action from me — mostly "{label}" — that I have not answered yet, oldest first. For each: who asked, what exactly they need from me, and since when. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
  {
    id: "arrivals-day-ahead",
    label: msg("Your day ahead"),
    blurb: msg(
      "Each morning: today's meetings, who is in them, and the last thread with each of them.",
    ),
    draft: {
      name: msg("My day ahead"),
      sourceKind: "none",
      scheduleCron: "0 8 * * *",
      channelKind: "email",
      instruction: `Each morning, go through today's meetings — mostly "{label}". For each: the time, what it is about, who is in it, and in one or two lines the last mail thread I had with them, so I walk in knowing where we left off. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
  {
    id: "arrivals-updates",
    label: msg("What changed, in one paragraph"),
    blurb: msg("Each morning: one paragraph of what changed, from the updates that arrived."),
    draft: {
      name: msg("What changed"),
      sourceKind: "none",
      scheduleCron: "0 9 * * *",
      channelKind: "email",
      instruction: `Each morning, read the status updates, reports and FYIs that arrived since yesterday — mostly "{label}" — and write one paragraph of what actually changed, then a short list of anything in them that needs me. Skip anything that changed nothing. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
  {
    id: "arrivals-admin",
    label: msg("The week's invoices and admin"),
    blurb: msg("Each Friday: the invoices, renewals and admin mail of the week, with due dates."),
    draft: {
      name: msg("This week's admin"),
      sourceKind: "none",
      scheduleCron: "0 9 * * 5",
      channelKind: "email",
      instruction: `Each Friday, list the invoices, payments, renewals, contracts and account mail that arrived this week — mostly "{label}". For each: from whom, what it is, the amount if there is one, and the due date if there is one; put anything due in the next two weeks first. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
  {
    id: "arrivals-candidates",
    label: msg("New candidates in one list"),
    blurb: msg("Each morning: new applications and interview mail, in one list."),
    draft: {
      name: msg("New candidates"),
      sourceKind: "none",
      scheduleCron: "0 9 * * *",
      channelKind: "email",
      instruction: `Each morning, list the job applications, interview scheduling and reference mail that arrived since yesterday — mostly "{label}". For each: the candidate's name, the role, what stage it is at, and what, if anything, they are waiting on from me. ${FROM_THE_MAILBOX}`,
    },
    requires: [],
    endsAfterRuns: null,
  },
];

export function arrivalTemplateById(id: string): RoutineTemplate | undefined {
  return ARRIVAL_TEMPLATES.find((t) => t.id === id);
}

/** A proposal's draft with its bucket's label in place of `{label}`. */
export function fillTemplate(template: RoutineTemplate, label: string): RoutineTemplate["draft"] {
  return { ...template.draft, instruction: template.draft.instruction.replace("{label}", label) };
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
      default:
        return assertNever(r);
    }
  });
}

/**
 * What to say instead of offering it — a key (`msg`), drawn with `lookup(t, …)`.
 *
 * Shown with the card rather than in place of it: hiding a template means
 * nobody learns it exists, and "an admin can turn this on" is a useful
 * sentence to read.
 */
export function requirementReason(requirement: TemplateRequirement): string {
  switch (requirement) {
    case "documents":
      return msg(
        "Upload something to this agent first — the series covers what the team has written down, and there is nothing to cover yet.",
      );
    case "admin":
      return msg(
        "Only an admin of this workspace can set this one up, because it reads across conversations an admin cannot otherwise see.",
      );
    case "gapReport":
      return msg(
        "An admin has to turn the coverage report on in Settings before a routine can read it.",
      );
    case "enoughPeople":
      return msg(
        "Not available for a workspace of exactly two — any topic the report named would tell one of you about the other, and no setting changes that. One person alone is fine: there is nobody to protect from.",
      );
    default:
      return assertNever(requirement);
  }
}
