import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ASKED_LIMIT,
  buildFollowUpMessages,
  generateFollowUps,
  parseFollowUps,
} from "./follow-ups";

const complete = vi.fn();
vi.mock("./completion", () => ({
  complete: (...args: unknown[]) => complete(...args),
}));

describe("buildFollowUpMessages", () => {
  it("puts question and answer into the user message", () => {
    const msgs = buildFollowUpMessages("What is TypeScript?", "TypeScript is a typed superset...");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("What is TypeScript?");
    expect(msgs[1].content).toContain("TypeScript is a typed superset...");
  });

  it("caps long inputs", () => {
    const long = "x".repeat(5000);
    const msgs = buildFollowUpMessages(long, long);
    expect(msgs[1].content.length).toBeLessThan(5000);
  });

  it("asks for the same language as the question", () => {
    const msgs = buildFollowUpMessages("Merhaba", "Cevap");
    expect(msgs[0].content).toContain("same language as the question");
  });

  it("names the questions already asked, so none of them is offered back", () => {
    // A tester had a question answered and was offered the same question as
    // the next step. The drafter had only ever seen the latest exchange.
    const msgs = buildFollowUpMessages("And the deadline?", "Friday.", [
      "What is the refund policy?",
      "Who approves expenses?",
    ]);
    expect(msgs[0].content).toContain("Never suggest a question that was already asked");
    expect(msgs[1].content).toContain("Already asked in this conversation:");
    expect(msgs[1].content).toContain("- What is the refund policy?");
    expect(msgs[1].content).toContain("- Who approves expenses?");
  });

  it("says nothing about earlier questions when there are none", () => {
    const msgs = buildFollowUpMessages("First question", "First answer");
    expect(msgs[1].content).not.toContain("Already asked");
    expect(buildFollowUpMessages("q", "a", ["  ", ""])[1].content).not.toContain("Already asked");
  });

  it("shows only the most recent earlier questions, each capped", () => {
    const asked = Array.from({ length: ASKED_LIMIT + 4 }, (_, i) => `Question ${i + 1}?`);
    asked.push("y".repeat(3000));
    const msgs = buildFollowUpMessages("q", "a", asked);
    // The oldest fall off the front; the newest survive.
    expect(msgs[1].content).not.toContain("- Question 1?");
    expect(msgs[1].content).toContain(`- Question ${ASKED_LIMIT + 4}?`);
    expect((msgs[1].content.match(/^- /gm) ?? []).length).toBe(ASKED_LIMIT);
    expect(msgs[1].content.length).toBeLessThan(3000);
  });
});

describe("generateFollowUps", () => {
  const env = { OPENAI_API_KEY: "sk-test" } as never;
  const usage = { promptTokens: 300, completionTokens: 512 };

  beforeEach(() => complete.mockReset());

  it("drops a list that stopped at the ceiling, and still reports the spend", async () => {
    // Three of 132 haiku drafts in October 2026 ended at exactly the old cap,
    // cut inside a string. Nothing parses out of that; what matters is that
    // the charge is still recorded and the log says why there are no chips.
    complete.mockResolvedValue({
      text: '{"questions":["What is the refund policy for',
      usage,
      finishReason: "length",
    });
    const out = await generateFollowUps(env, "claude-haiku-4-5", "q", "a");
    expect(out.questions).toEqual([]);
    expect(out.spend).toMatchObject({ kind: "completion", completionTokens: 512 });
  });

  it("parses a finished list and hands the drafter the earlier questions", async () => {
    complete.mockResolvedValue({
      text: '{"questions":["How long does it take?"]}',
      usage,
      finishReason: "stop",
    });
    const out = await generateFollowUps(env, "gpt-4o-mini", "q", "a", ["Earlier one?"]);
    expect(out.questions).toEqual(["How long does it take?"]);
    const req = complete.mock.calls[0][1] as { messages: { content: string }[] };
    expect(req.messages[1].content).toContain("- Earlier one?");
  });
});

describe("parseFollowUps", () => {
  it("parses a well-formed response", () => {
    const raw = '{"questions":["What else?","How does it work?","Any examples?"]}';
    expect(parseFollowUps(raw)).toEqual(["What else?", "How does it work?", "Any examples?"]);
  });

  it("returns empty for malformed JSON", () => {
    expect(parseFollowUps("not json")).toEqual([]);
  });

  it("returns empty for missing questions key", () => {
    expect(parseFollowUps('{"items":["a","b"]}')).toEqual([]);
  });

  it("filters out non-string entries", () => {
    const raw = '{"questions":["Valid",123,null,"Also valid"]}';
    expect(parseFollowUps(raw)).toEqual(["Valid", "Also valid"]);
  });

  it("filters out empty strings", () => {
    const raw = '{"questions":["Good","","  ","Fine"]}';
    expect(parseFollowUps(raw)).toEqual(["Good", "Fine"]);
  });

  it("handles a fenced JSON response", () => {
    expect(parseFollowUps('```json\n{"questions":["a"]}\n```')).toEqual([]);
  });
});
