import { describe, expect, it } from "vitest";
import { englishT } from "@/i18n";
import {
  activityLine,
  amountValue,
  amountWords,
  countWord,
  feedTime,
  greeting,
  homeDate,
  homeSentence,
  needsYouParts,
  spendNote,
  weekDelta,
  workingOnDetail,
} from "./home-sentence";

// Thursday 22 October 2026, 09:30 in Istanbul (06:30 UTC).
const NOW = new Date("2026-10-22T06:30:00Z");
const TZ = "Europe/Istanbul";

describe("the greeting and the date", () => {
  it("reads the clock in the person's own zone", () => {
    expect(greeting(NOW, "Mina Kaya", TZ)).toBe("Good morning, Mina.");
    expect(greeting(NOW, "Mina Kaya", "America/Los_Angeles")).toBe("Good evening, Mina.");
    expect(greeting(new Date("2026-10-22T11:00:00Z"), null, TZ)).toBe("Good afternoon, there.");
  });

  it("says the day and the date, and survives a zone it does not know", () => {
    expect(homeDate(NOW, TZ)).toBe("Thursday, 22 October");
    expect(() => homeDate(NOW, "Not/AZone")).not.toThrow();
  });
});

describe("homeSentence", () => {
  it("says the board's sentence", () => {
    expect(
      homeSentence({
        now: NOW,
        timeZone: TZ,
        needsYou: 3,
        running: [{ agent: "Research", title: "Weekly competitor brief" }],
        spend: { amount: 612, unit: "credits", days: 7 },
      }),
    ).toBe(
      "Thursday, 22 October. Three things need you, Research is working on Weekly competitor brief, and the team has spent 612 credits in the last seven days.",
    );
  });

  it("leaves the money out for somebody who is not shown it, and names nothing running", () => {
    expect(homeSentence({ now: NOW, timeZone: TZ, needsYou: 0, running: [], spend: null })).toBe(
      "Thursday, 22 October. Nothing needs you.",
    );
    expect(
      homeSentence({
        now: NOW,
        timeZone: TZ,
        needsYou: 1,
        running: [
          { agent: "Research", title: null },
          { agent: "Finance", title: "x" },
        ],
      }),
    ).toBe("Thursday, 22 October. One thing needs you, and Research and Finance are working.");
  });

  it("counts many agents, and quotes dollars where there are no credits", () => {
    expect(
      homeSentence({
        now: NOW,
        timeZone: TZ,
        needsYou: 14,
        running: [
          { agent: "A", title: null },
          { agent: "B", title: null },
          { agent: "C", title: null },
        ],
        spend: { amount: 4.5, unit: "usd", days: 7 },
      }),
    ).toBe(
      "Thursday, 22 October. 14 things need you, three agents are working, and the team has spent $4.50 in the last seven days.",
    );
  });

  it("does not end a title's question mark with a full stop", () => {
    expect(
      homeSentence({
        now: NOW,
        timeZone: TZ,
        needsYou: 0,
        running: [{ agent: "Support", title: "Can we refund EU orders?" }],
      }),
    ).toBe(
      "Thursday, 22 October. Nothing needs you, and Support is working on Can we refund EU orders.",
    );
  });
});

describe("figures", () => {
  it("writes credits and dollars", () => {
    expect(amountValue(1240, "credits")).toBe("1,240");
    expect(amountValue(4.5, "usd")).toBe("$4.50");
    expect(amountWords(1, "credits")).toBe("1 credit");
    expect(amountWords(612, "credits")).toBe("612 credits");
    expect(countWord(7)).toBe("seven");
    expect(countWord(13)).toBe("13");
  });

  it("says what Needs you is made of and how the week moved", () => {
    expect(needsYouParts({ questions: 2, approvals: 1, other: 0 })).toBe("2 questions, 1 approval");
    expect(needsYouParts({ questions: 0, approvals: 0, other: 1 })).toBe("1 more");
    expect(weekDelta(48, 36)).toBe("+12 vs the week before");
    expect(weekDelta(3, 6)).toBe("−3 vs the week before");
    expect(weekDelta(5, 5)).toBe("Same as the week before");
  });
});

describe("spendNote", () => {
  const day = (byAgent: Record<string, number>) => ({ byAgent });
  const names = (id: string) => ({ r: "Research", s: "Support" })[id];

  it("names the agent whose week went up the most", () => {
    const daily = [
      ...Array.from({ length: 7 }, () => day({ r: 20, s: 30 })),
      ...Array.from({ length: 7 }, () => day({ r: 40, s: 31 })),
    ];
    expect(spendNote(daily, names, "credits")).toBe(
      "Research is up this week: 280 credits against 140 the week before.",
    );
  });

  it("says nothing when no agent went up by a quarter, or one is new", () => {
    const flat = Array.from({ length: 14 }, () => day({ r: 10 }));
    expect(spendNote(flat, names, "credits")).toBeNull();
    const fresh = [
      ...Array.from({ length: 7 }, () => day({})),
      ...Array.from({ length: 7 }, () => day({ r: 10 })),
    ];
    expect(spendNote(fresh, names, "credits")).toBeNull();
  });
});

describe("Right now and Recent activity", () => {
  const now = new Date(2026, 9, 22, 10, 0).getTime();

  it("says what each agent is doing", () => {
    expect(
      workingOnDetail({ kind: "running", stepsDone: 3, note: "reading 6 pages", since: now }, now),
    ).toBe("step 3, reading 6 pages");
    expect(workingOnDetail({ kind: "question", since: now - 12 * 60_000 }, now)).toBe(
      "asked you a question 12 min ago",
    );
    expect(workingOnDetail({ kind: "approval", since: now }, now)).toBe(
      "waiting for your approval",
    );
    expect(
      workingOnDetail({ kind: "last", since: new Date(2026, 9, 21, 15, 0).getTime() }, now),
    ).toBe("yesterday");
  });

  it("writes the time on a feed row as short as it reads", () => {
    expect(feedTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(feedTime(now - 5 * 3_600_000, now)).toBe("5 h ago");
    expect(
      feedTime(new Date(2026, 9, 22, 1, 0).getTime(), new Date(2026, 9, 22, 9, 0).getTime()),
    ).toBe("01:00");
    expect(feedTime(new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe("Yesterday");
  });

  // The line is a key with the subject marked `<s>…</s>`, so the page can draw
  // the subject as a link and the translation can put it where its grammar
  // wants it. Rendered through englishT here, the way an untranslated page
  // would read it.
  it("words each kind of event", () => {
    const base = { subjectLabel: "Pipeline snapshot", count: 1, detail: null };
    const words = (item: Parameters<typeof activityLine>[0]) => {
      const line = activityLine(item);
      return englishT(line.key, line.values).replace(/<\/?s>/g, "");
    };
    expect(words({ ...base, action: "turn.approved" })).toBe("approved Pipeline snapshot");
    expect(words({ ...base, action: "session.shared" })).toBe(
      "shared Pipeline snapshot with the team",
    );
    expect(
      words({
        action: "document.added",
        subjectLabel: "nda.pdf",
        count: 3,
        detail: { bundle_name: "Contracts" },
      }),
    ).toBe("added 3 files to Knowledge / Contracts");
    expect(
      words({ action: "document.added", subjectLabel: "nda.pdf", count: 1, detail: null }),
    ).toBe("added nda.pdf to Knowledge");
    expect(activityLine({ ...base, action: "turn.approved" }).values.subject).toBe(
      "Pipeline snapshot",
    );
  });
});
