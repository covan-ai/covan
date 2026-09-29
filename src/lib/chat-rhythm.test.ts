import { describe, it, expect } from "vitest";
import type { Message } from "@/lib/agents-store";
import { gapBefore } from "./chat-rhythm";

const user = (id: string): Message => ({ id, role: "user", content: "q", createdAt: 0 });
const bot = (id: string): Message => ({ id, role: "assistant", content: "a", createdAt: 0 });

describe("gapBefore", () => {
  it("opens the transcript flush with the top of it", () => {
    expect(gapBefore(undefined, user("m1"), false)).toBe("none");
  });

  it("keeps an answer close to the question it answers", () => {
    // The one gap in a transcript that has to read as "these two belong
    // together". Everything the design does about rhythm comes back to this
    // being smaller than the one around it.
    expect(gapBefore(user("m1"), bot("m2"), false)).toBe("tight");
  });

  it("puts air between one exchange and the next", () => {
    expect(gapBefore(bot("m1"), user("m2"), false)).toBe("loose");
  });

  it("treats two questions in a row as two exchanges", () => {
    // Somebody adding a second thought before the reply lands. Those are not
    // a pair, and drawing them as one makes the answer look like it belongs to
    // the first of them.
    expect(gapBefore(user("m1"), user("m2"), false)).toBe("loose");
  });

  it("does not pair a reply with the reply before it", () => {
    // A regenerated or continued answer can sit under another answer. Two
    // answers are not a question and its answer.
    expect(gapBefore(bot("m1"), bot("m2"), false)).toBe("loose");
  });

  it("adds nothing under a date divider, which brings its own space", () => {
    // The divider is a sibling of the turn, not part of it, and it already has
    // padding on both sides. A margin on top of that is two gaps in a row.
    expect(gapBefore(bot("m1"), user("m2"), true)).toBe("none");
    expect(gapBefore(user("m1"), bot("m2"), true)).toBe("none");
  });
});
