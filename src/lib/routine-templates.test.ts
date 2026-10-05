import { describe, it, expect } from "vitest";
import { scheduleError } from "@/components/routines/schedule-picker";
import {
  ROUTINE_TEMPLATES,
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
  it("ships the three the spec names, by id", () => {
    expect(ROUTINE_TEMPLATES.map((t) => t.id)).toEqual([
      "first-week",
      "gap-report",
      "weekly-digest",
    ]);
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

  it("only an rss or web template carries a url, and it carries one", () => {
    for (const t of ROUTINE_TEMPLATES) {
      const wantsUrl = t.draft.sourceKind === "rss" || t.draft.sourceKind === "web";
      expect(t.draft.sourceUrl !== null, `${t.id} url presence`).toBe(wantsUrl);
    }
  });

  it("ends only where the spec says a series ends", () => {
    expect(templateById("first-week")!.endsAfterRuns).toBe(7);
    expect(templateById("gap-report")!.endsAfterRuns).toBeNull();
    expect(templateById("weekly-digest")!.endsAfterRuns).toBeNull();
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

  it("refuses the report below the floor's member count", () => {
    for (const memberCount of [1, 2]) {
      const unmet = unmetRequirements(templateById("gap-report")!, {
        ...ready,
        memberCount,
      });
      expect(unmet, `${memberCount} members`).toContain("enoughPeople");
    }
    expect(
      unmetRequirements(templateById("gap-report")!, {
        ...ready,
        memberCount: GAP_REPORT_MIN_MEMBERS,
      }),
    ).toEqual([]);
  });

  it("gives every requirement a sentence that says what to do", () => {
    for (const r of ["documents", "admin", "gapReport", "enoughPeople"] as const) {
      expect(requirementReason(r).length, r).toBeGreaterThan(30);
    }
  });
});
