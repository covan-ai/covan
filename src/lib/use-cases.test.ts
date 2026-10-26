import { describe, expect, it } from "vitest";
import { scheduleError } from "@/components/routines/schedule-picker";
import { FROM_THE_MAILBOX } from "./routine-templates";
import {
  SECTIONS,
  USE_CASES,
  WELCOME_CARDS,
  connectionGroupName,
  stepIdFor,
  templateById,
  findUseCase,
  type RoutineUseCase,
} from "./use-cases";

const routines = USE_CASES.filter((u): u is RoutineUseCase => u.kind === "routine");
/** A card with a mailbox group. Outlook alone is no sign: it is a calendar too. */
const readsMail = (u: RoutineUseCase) =>
  (u.needs.connections ?? []).some((group) => group.includes("gmail"));

describe("the catalogue", () => {
  it("has unique, lowercase ids short enough for an onboarding step", () => {
    const ids = USE_CASES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(id.length, id).toBeLessThanOrEqual(31);
      // The worker's STEP_ID (worker/src/lib/onboarding.ts).
      expect(stepIdFor(id), id).toMatch(/^[a-z][a-z0-9:-]{0,39}$/);
    }
  });

  it("gives every routine a schedule the engine accepts", () => {
    for (const u of routines) {
      expect(scheduleError(u.routine.scheduleCron), `${u.id}'s cron`).toBeNull();
    }
  });

  it("names no feed or page source, which the editor has no field for", () => {
    for (const u of routines) {
      expect(["rss", "web"], u.id).not.toContain(u.routine.sourceKind);
    }
  });

  it("puts something in every section", () => {
    for (const s of SECTIONS) {
      expect(
        USE_CASES.some((u) => u.section === s.id),
        s.id,
      ).toBe(true);
    }
  });

  it("has a card in Team and knowledge that needs nothing at all", () => {
    expect(routines.some((u) => u.section === "team" && Object.keys(u.needs).length === 0)).toBe(
      true,
    );
  });

  it("shows only marks for apps a card says it needs", () => {
    for (const u of USE_CASES) {
      const needed = (u.needs.connections ?? []).flat();
      for (const mark of u.apps) {
        if (typeof mark === "object")
          expect(needed, `${u.id} shows ${mark.toolkit}`).toContain(mark.toolkit);
      }
    }
  });
});

describe("the links that were there before the catalogue", () => {
  it("opens first-week exactly as it always did", () => {
    const t = templateById("first-week")!;
    expect({ ...t, draft: { ...t.draft, instruction: "" } }).toEqual({
      id: "first-week",
      label: "Somebody's first week",
      blurb: "One note each morning for a week, from what the team has written down.",
      draft: {
        name: "First week",
        sourceKind: "none",
        scheduleCron: "0 9 * * *",
        channelKind: "email",
        instruction: "",
      },
      requires: ["documents"],
      endsAfterRuns: 7,
    });
    expect(t.draft.instruction).toMatch(
      /^Each morning of somebody's first week, cover one subject/,
    );
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(t.draft.instruction, `morning ${n}`).toContain(`${n}.`);
    }
  });

  it("opens gap-report exactly as it always did", () => {
    expect(templateById("gap-report")).toEqual({
      id: "gap-report",
      label: "What nobody wrote down",
      blurb: "Weekly: the topics your team asked about that no document covered.",
      draft: {
        name: "Coverage gaps",
        sourceKind: "workspace",
        scheduleCron: "0 9 * * 1",
        channelKind: "email",
        instruction:
          "Report the topics this workspace asked about that its own documents did not cover. Clustered, never named, and never anybody's question text.",
      },
      requires: ["admin", "gapReport", "enoughPeople"],
      endsAfterRuns: null,
    });
  });

  it("opens nothing for an agent card, a scan's proposal or a retired id", () => {
    expect(templateById("support-agent")).toBeUndefined();
    expect(templateById("arrivals-questions")).toBeUndefined();
    expect(templateById("weekly-digest")).toBeUndefined();
    expect(templateById("no-such-template")).toBeUndefined();
  });
});

describe("what a card may change", () => {
  it("changes things only where it connects, and says it does nothing else there", () => {
    const changing = routines.filter((u) => u.needs.changes?.length);
    expect(changing.length).toBeGreaterThan(0);
    for (const u of changing) {
      const connected = (u.needs.connections ?? []).flat();
      expect(connected.length, u.id).toBeGreaterThan(0);
      for (const toolkit of u.needs.changes!) expect(connected, u.id).toContain(toolkit);
      expect(u.routine.instruction, u.id).toMatch(/only\./);
      expect(u.routine.instruction, u.id).toMatch(/Never /);
      expect(u.routine.instruction, u.id).toMatch(
        / only\. Never send, reply, delete or change anything else there\.$/,
      );
    }
  });

  it("ends every card that only reads mail with the mailbox sentence", () => {
    const reading = routines.filter((u) => readsMail(u) && !u.needs.changes?.length);
    expect(reading.length).toBeGreaterThan(0);
    for (const u of reading) {
      expect(u.routine.instruction.endsWith(FROM_THE_MAILBOX), u.id).toBe(true);
    }
  });
});

describe("the cards other screens name", () => {
  it("shows the welcome three routines that need only a connection", () => {
    for (const id of WELCOME_CARDS) {
      const u = findUseCase(id);
      expect(u?.kind, id).toBe("routine");
      expect(Object.keys(u!.needs), id).toEqual(["connections"]);
    }
  });

  it("names the event each event card waits for", () => {
    const events = routines.filter((u) => u.routine.triggerKind === "event");
    expect(events.map((u) => [u.id, u.routine.event?.type]).sort()).toEqual([
      ["new-booking", "gcal.event_created"],
      ["shipped", "github.push"],
    ]);
  });

  it("names a group the way a person reads it", () => {
    expect(connectionGroupName(["gmail", "outlook"])).toBe("Gmail or Outlook");
    expect(connectionGroupName(["hubspot"])).toBe("HubSpot");
    expect(connectionGroupName(["slack"])).toBe("Slack (as a connected app)");
  });
});
