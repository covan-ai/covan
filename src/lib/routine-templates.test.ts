import { describe, it, expect } from "vitest";
import { scheduleError } from "@/components/routines/schedule-picker";
import { PROPOSAL_FOR } from "./arrivals";
import {
  ARRIVAL_TEMPLATES,
  ROUTINE_TEMPLATES,
  arrivalTemplateById,
  fillTemplate,
  templateById,
  unmetRequirements,
  requirementReason,
  GAP_REPORT_MIN_MEMBERS,
  type TemplateFacts,
} from "./routine-templates";

/** A workspace where every requirement is satisfied. */
const ready: TemplateFacts = {
  agentDocumentCount: 4,
  isAdmin: true,
  gapReportEnabled: true,
  memberCount: 5,
};

describe("the templates themselves", () => {
  it("ships the two the dialog can complete, by id", () => {
    // `weekly-digest` was the third. It needed the URL field covan#241 took
    // out of the dialog on purpose, so it is gone rather than shown disabled.
    expect(ROUTINE_TEMPLATES.map((t) => t.id)).toEqual(["first-week", "gap-report"]);
  });

  /**
   * The drift test, and the reason this file exists at all. A template is a
   * routine definition written months before anybody creates one, so a cron the
   * engine refuses is a button that fails and nothing that notices. Same move
   * 0063's model catalogue makes.
   */
  it("every template's schedule is one the engine accepts", () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(scheduleError(t.draft.scheduleCron), `${t.id}'s cron`).toBeNull();
    }
  });

  it("names no feed or page source, which the dialog has no field for", () => {
    // Also held by the type (`CreatableSourceKind`); this is the runtime half,
    // for a template that ever arrives through a cast.
    for (const t of ROUTINE_TEMPLATES) {
      expect(["rss", "web"], t.id).not.toContain(t.draft.sourceKind);
    }
  });

  it("ends only where the spec says a series ends", () => {
    expect(templateById("first-week")!.endsAfterRuns).toBe(7);
    expect(templateById("gap-report")!.endsAfterRuns).toBeNull();
  });

  it("enumerates seven mornings in the first-week instruction", () => {
    const instruction = templateById("first-week")!.draft.instruction;
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(instruction, `morning ${n}`).toContain(`${n}.`);
    }
  });

  it("answers nothing for an id it has never heard of", () => {
    expect(templateById("no-such-template")).toBeUndefined();
  });

  it("answers nothing for the retired weekly digest, so an old link opens step 1", () => {
    expect(templateById("weekly-digest")).toBeUndefined();
  });
});

describe("what a screen's facts leave unmet", () => {
  it("asks for nothing when everything is in place", () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(unmetRequirements(t, ready), t.id).toEqual([]);
    }
  });

  /**
   * Review Focus 5. The routines screen is scoped to one agent and the series
   * reads that agent's documents, so a workspace with documents hung off a
   * different agent is still not ready *here*. Pinned so a later change to
   * "does the workspace have any documents" is a failing test rather than a
   * series that greets somebody with nothing to say.
   */
  it("reads documents per agent, not per workspace", () => {
    const unmet = unmetRequirements(templateById("first-week")!, {
      ...ready,
      agentDocumentCount: 0,
    });
    expect(unmet).toEqual(["documents"]);
  });

  it("refuses the report to somebody who is not an admin", () => {
    const unmet = unmetRequirements(templateById("gap-report")!, {
      ...ready,
      isAdmin: false,
    });
    expect(unmet).toContain("admin");
  });

  it("refuses the report while the workspace has not turned it on", () => {
    const unmet = unmetRequirements(templateById("gap-report")!, {
      ...ready,
      gapReportEnabled: false,
    });
    expect(unmet).toContain("gapReport");
  });

  it("refuses the report for a workspace of exactly two", () => {
    const unmet = unmetRequirements(templateById("gap-report")!, {
      ...ready,
      memberCount: 2,
    });
    expect(unmet).toContain("enoughPeople");
  });

  /**
   * A1. The gate used to block this alongside two — `memberCount < 3` — which
   * contradicted `askerFloor`'s own `1 -> 1` branch (the engine already
   * allows a solo workspace), the docs, and this file's own three-lines-above
   * comment on `GAP_REPORT_MIN_MEMBERS`. This is the regression test for that:
   * it fails the moment "below the floor" creeps back in as the condition.
   */
  it("allows the report for a workspace of one — there is nobody to protect from", () => {
    const unmet = unmetRequirements(templateById("gap-report")!, {
      ...ready,
      memberCount: 1,
    });
    expect(unmet).not.toContain("enoughPeople");
  });

  it("allows the report once the workspace reaches the floor", () => {
    expect(
      unmetRequirements(templateById("gap-report")!, {
        ...ready,
        memberCount: GAP_REPORT_MIN_MEMBERS,
      }),
    ).toEqual([]);
  });

  /**
   * The cases above only prove the gate blocks exactly two. The floor itself
   * — what `askerFloor` uses once a workspace reaches 3 or more — is a
   * separate number this pins directly. The worker keeps its own copy of it
   * (`src/` cannot import from `worker/src/`), and a literal-drift test on
   * each side is the only thing that catches the two disagreeing.
   */
  it("pins the floor at 3, so the worker's matching copy cannot drift unnoticed", () => {
    expect(GAP_REPORT_MIN_MEMBERS).toBe(3);
  });

  it("gives every requirement a sentence that says what to do", () => {
    for (const r of ["documents", "admin", "gapReport", "enoughPeople"] as const) {
      expect(requirementReason(r).length, r).toBeGreaterThan(30);
    }
  });
});

describe("the proposals a scan of what arrived makes", () => {
  it("has one template for every kind that proposes one", () => {
    expect(ARRIVAL_TEMPLATES.map((t) => t.id).sort()).toEqual(Object.values(PROPOSAL_FOR).sort());
  });

  it("are morning digests from the mail, never anything else", () => {
    for (const t of ARRIVAL_TEMPLATES) {
      expect(t.draft.sourceKind, t.id).toBe("none");
      expect(t.draft.channelKind, t.id).toBe("email");
      expect(t.requires, t.id).toEqual([]);
      expect(t.endsAfterRuns, t.id).toBeNull();
      expect(scheduleError(t.draft.scheduleCron), `${t.id}'s cron`).toBeNull();
      expect(t.draft.instruction.split("{label}"), `${t.id} names its bucket once`).toHaveLength(2);
      expect(t.draft.instruction, t.id).toMatch(/never send/i);
    }
  });

  it("runs the day ahead before the others, and the admin once a week", () => {
    expect(arrivalTemplateById("arrivals-day-ahead")!.draft.scheduleCron).toBe("0 8 * * *");
    expect(arrivalTemplateById("arrivals-admin")!.draft.scheduleCron).toBe("0 9 * * 5");
    expect(arrivalTemplateById("arrivals-questions")!.draft.scheduleCron).toBe("0 9 * * *");
  });

  it("is not offered where a template is picked, since it needs a bucket's label", () => {
    expect(templateById("arrivals-questions")).toBeUndefined();
  });

  it("fills the bucket's label in", () => {
    const draft = fillTemplate(
      arrivalTemplateById("arrivals-questions")!,
      "Questions about the spring order",
    );
    expect(draft.instruction).toContain("Questions about the spring order");
    expect(draft.instruction).not.toContain("{label}");
    expect(draft.scheduleCron).toBe("0 9 * * *");
  });
});
