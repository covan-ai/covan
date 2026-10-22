import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/api-client";
import { inboxDot, inboxLine } from "./inbox";

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  sessionId: "s1",
  agentId: "a1",
  title: "Refund policy for EU orders",
  kind: "chat",
  visibility: "private",
  ownerId: "u1",
  ownerName: "Mina Kaya",
  sharedBy: null,
  preview: { role: "assistant", senderName: null, text: "Here is the policy.", at: 1 },
  unread: true,
  unreadCount: 1,
  needsYou: null,
  running: null,
  lastActivityAt: 1,
  ...over,
});

describe("an inbox row", () => {
  it("dots what waits on you as a ring, what runs as the breathing fill, a failure red", () => {
    expect(
      inboxDot(item({ needsYou: { kind: "question", summary: "?", since: 1 } as never })),
    ).toBe("waiting");
    expect(
      inboxDot(item({ needsYou: { kind: "routine_failed", summary: "x", since: 1 } as never })),
    ).toBe("failed");
    expect(
      inboxDot(item({ running: { stepsDone: 2, lastTool: null, note: null, since: 1 } })),
    ).toBe("running");
    expect(inboxDot(item())).toBe("done");
  });

  it("says why it is here: the question, the step, or the last word and whose it was", () => {
    expect(
      inboxLine(
        item({ needsYou: { kind: "question", summary: "Draft the reply?", since: 1 } as never }),
        "Support",
      ),
    ).toEqual({ who: "Support", text: "Draft the reply?" });
    expect(
      inboxLine(
        item({ running: { stepsDone: 2, lastTool: null, note: null, since: 1 } }),
        "Research",
      ),
    ).toEqual({ who: "Research", text: "Working · step 3" });
    expect(
      inboxLine(
        item({ preview: { role: "user", senderName: "Can B.", text: "Thanks", at: 1 } }),
        "Support",
      ),
    ).toEqual({ who: "Can B.", text: "Thanks" });
  });
});
