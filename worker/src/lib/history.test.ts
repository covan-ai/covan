import { describe, it, expect } from "vitest";
import { attributeSenders, capContent, FORMER_MEMBER, selectHistory, senderNames } from "./history";

const size = (turns: { content: string }[]) => turns.reduce((n, t) => n + t.content.length, 0);

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

describe("selectHistory", () => {
  it("returns empty for empty input", () => {
    expect(selectHistory([])).toEqual([]);
  });

  it("keeps everything when under budget, preserving chronological order", () => {
    const rows = [turn("user", "a"), turn("assistant", "b"), turn("user", "c")];
    expect(selectHistory(rows)).toEqual(rows);
  });

  it("drops the oldest messages once the budget is exhausted", () => {
    const rows = [
      turn("user", "x".repeat(100)),
      turn("assistant", "y".repeat(100)),
      turn("user", "z".repeat(100)),
    ];
    const out = selectHistory(rows, { maxChars: 150, perMessageCap: 1000 });
    // Newest-first admission: "z" (100) fits, "y" would push to 200 > 150 → stop.
    expect(out).toEqual([turn("user", "z".repeat(100))]);
  });

  it("always keeps the newest message even if it alone exceeds the budget", () => {
    const rows = [turn("user", "old"), turn("user", "z".repeat(100))];
    const out = selectHistory(rows, { maxChars: 10, perMessageCap: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("z".repeat(100));
  });

  it("caps an oversized older message, keeping its head and tail and saying what was cut", () => {
    const rows = [turn("user", "h".repeat(5000) + "t".repeat(5000)), turn("user", "next")];
    const out = selectHistory(rows, { perMessageCap: 200 });
    expect(out[0].content.length).toBeLessThanOrEqual(200);
    expect(out[0].content.startsWith("h")).toBe(true);
    expect(out[0].content.endsWith("t")).toBe(true);
    expect(out[0].content).toMatch(/\[… [\d,]+ characters omitted …\]/);
  });

  // A paste followed by the question about it. Capping the turn being answered
  // at the ordinary 6,000 sent the paste's head and dropped the question.
  it("sends the newest message whole up to its own, larger cap", () => {
    const paste = "x".repeat(20_000) + "\nReply with only: LONG-OK";
    const out = selectHistory([turn("user", "older"), turn("user", paste)], {
      perMessageCap: 100,
      newestCap: 50_000,
    });
    expect(out[out.length - 1].content).toBe(paste);
  });

  it("keeps the question at the end of a newest message past even its own cap", () => {
    const paste = "x".repeat(80_000) + "\nReply with only: LONG-OK";
    const out = selectHistory([turn("user", paste)], { perMessageCap: 100, newestCap: 1_000 });
    expect(out[0].content.length).toBeLessThanOrEqual(1_000);
    expect(out[0].content.endsWith("Reply with only: LONG-OK")).toBe(true);
  });

  it("does not let a long newest message push the conversation before it out", () => {
    const rows = [
      turn("user", "a".repeat(90)),
      turn("assistant", "b".repeat(90)),
      turn("user", "c".repeat(5000)),
    ];
    const out = selectHistory(rows, { maxChars: 300, perMessageCap: 100, newestCap: 10_000 });
    expect(out).toHaveLength(3);
    expect(out[2].content).toBe("c".repeat(5000));
  });

  it("caps the newest message at the ordinary cap once it is no longer newest", () => {
    const rows = [turn("user", "c".repeat(5000)), turn("assistant", "ok")];
    const out = selectHistory(rows, { perMessageCap: 100, newestCap: 10_000 });
    expect(out[0].content.length).toBeLessThanOrEqual(100);
  });

  it("counts capped (not original) length against the budget", () => {
    const rows = [
      turn("user", "a".repeat(5000)),
      turn("assistant", "b".repeat(5000)),
      turn("user", "c".repeat(5000)),
    ];
    // Each weighs 100 against a 250 budget, so the oldest goes — the cap is what
    // is measured, not the 5000 originals.
    const out = selectHistory(rows, { maxChars: 250, perMessageCap: 100, newestCap: 100 });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.content.length <= 100)).toBe(true);
  });
});

describe("capContent", () => {
  it("returns what already fits untouched", () => {
    expect(capContent("short", 100)).toBe("short");
  });

  it("never exceeds the cap, and reports the omitted count truthfully", () => {
    for (const len of [101, 500, 12_345, 1_000_000]) {
      const text = "z".repeat(len);
      const out = capContent(text, 100);
      expect(out.length).toBeLessThanOrEqual(100);
      const omitted = Number(/\[… ([\d,]+) characters/.exec(out)![1].replace(/,/g, ""));
      const kept = out.replace(/\n\n\[…[^\]]*\]\n\n/, "").length;
      expect(omitted + kept).toBe(len);
    }
  });

  it("keeps the same oldest message across turns until the slack is spent", () => {
    // A conversation growing ten chars a turn, well past a 100-char ceiling.
    // Trimming to the ceiling would move the front on every turn past the line;
    // with 40 chars of slack it may move at most once per 40 chars appended.
    const rows: ReturnType<typeof turn>[] = [];
    const fronts: string[] = [];
    let moves = 0;
    for (let i = 0; i < 60; i++) {
      rows.push(turn(i % 2 ? "assistant" : "user", String(i).padStart(10, "_")));
      const out = selectHistory(rows, { maxChars: 100, lowWater: 60, perMessageCap: 1000 });
      expect(size(out)).toBeLessThanOrEqual(100);
      if (fronts.length > 0 && out[0].content !== fronts[fronts.length - 1]) moves++;
      fronts.push(out[0].content);
    }
    const appendedPastCeiling = 60 * 10 - 100;
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(Math.ceil(appendedPastCeiling / 40));
  });

  it("cuts back to the low-water mark, not the ceiling", () => {
    // Eleven 10-char messages: 110 chars, ten over a 100-char ceiling.
    const rows = Array.from({ length: 11 }, (_, i) => turn("user", String(i).padStart(10, "_")));
    const out = selectHistory(rows, { maxChars: 100, lowWater: 60, perMessageCap: 1000 });
    // The old cut kept exactly 100. This one keeps the low-water mark plus at
    // most one message's worth of rounding — and still ends on the newest.
    expect(size(out)).toBeGreaterThan(60);
    expect(size(out)).toBeLessThanOrEqual(60 + 10);
    expect(out[out.length - 1]).toEqual(rows[10]);
  });

  it("never returns more than maxChars", () => {
    // A seeded generator, so a failure reproduces.
    let seed = 250;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 50; run++) {
      const rows = Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
        turn("user", "m".repeat(1 + Math.floor(next() * 300))),
      );
      const maxChars = 300 + Math.floor(next() * 2000);
      const out = selectHistory(rows, { maxChars, perMessageCap: 1000 });
      expect(size(out)).toBeLessThanOrEqual(maxChars);
      expect(out[out.length - 1]).toEqual(rows[rows.length - 1]);
      // What is kept is always a contiguous, newest suffix.
      expect(out).toEqual(rows.slice(rows.length - out.length));
    }
  });

  it("behaves exactly as before when lowWater equals maxChars", () => {
    // The old rule: admit newest-first while it fits, newest always kept.
    const before = (rows: ReturnType<typeof turn>[], maxChars: number) => {
      const kept: ReturnType<typeof turn>[] = [];
      let used = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const len = rows[i].content.length;
        if (kept.length > 0 && used + len > maxChars) break;
        kept.push(rows[i]);
        used += len;
      }
      return kept.reverse();
    };
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 50; run++) {
      const rows = Array.from({ length: 1 + Math.floor(next() * 30) }, () =>
        turn("assistant", "n".repeat(1 + Math.floor(next() * 200))),
      );
      const maxChars = 50 + Math.floor(next() * 1500);
      expect(selectHistory(rows, { maxChars, lowWater: maxChars, perMessageCap: 1000 })).toEqual(
        before(rows, maxChars),
      );
    }
  });
});

describe("attributeSenders", () => {
  const ADA = "00000000-0000-4000-8000-00000000ada0";
  const GRACE = "00000000-0000-4000-8000-0000000g0ace";
  const names = new Map([
    [ADA, "Ada"],
    [GRACE, "Grace"],
  ]);
  const row = (role: "user" | "assistant", content: string, sender_id: string | null = null) => ({
    role,
    content,
    sender_id,
  });

  it("leaves a private thread's history byte-identical", () => {
    const rows = [row("user", "hi", ADA), row("assistant", "hello"), row("user", "and?", GRACE)];
    const out = attributeSenders(rows, names, false);
    expect(JSON.stringify(out)).toBe(
      JSON.stringify([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and?" },
      ]),
    );
  });

  it("prefixes each person's turns with their name in a shared thread", () => {
    const out = attributeSenders(
      [row("user", "hi", ADA), row("assistant", "hello"), row("user", "and?", GRACE)],
      names,
      true,
    );
    expect(out).toEqual([
      { role: "user", content: "Ada: hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "Grace: and?" },
    ]);
  });

  it('names a sender whose profile is gone "A former member"', () => {
    const out = attributeSenders([row("user", "bye", "someone-who-left")], names, true);
    expect(FORMER_MEMBER).toBe("A former member");
    expect(out).toEqual([{ role: "user", content: "A former member: bye" }]);
  });

  it("leaves a user turn with no sender untouched, as the ones written before 0008 are", () => {
    const out = attributeSenders([row("user", "old", null)], names, true);
    expect(out).toEqual([{ role: "user", content: "old" }]);
  });

  it("never prefixes an assistant turn, even one that carries a sender", () => {
    const out = attributeSenders([row("assistant", "hello", ADA)], names, true);
    expect(out).toEqual([{ role: "assistant", content: "hello" }]);
  });
});

describe("senderNames", () => {
  it("names a person as the team block does, on one line", () => {
    const names = senderNames([
      { id: "a", name: "Ada\nLovelace" },
      { id: "b", name: "   " },
      { id: "c", name: null },
    ]);
    expect(names.get("a")).toBe("Ada Lovelace");
    expect(names.get("b")).toBe("A member with no name yet");
    expect(names.get("c")).toBe("A member with no name yet");
    expect(names.has("d")).toBe(false);
  });
});
