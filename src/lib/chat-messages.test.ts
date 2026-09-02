import { describe, it, expect } from "vitest";
import type { Message } from "@/lib/agents-store";
import { mergeRealtimeMessage, optimisticId } from "./chat-messages";

const msg = (over: Partial<Message> & { id: string }): Message => ({
  role: "user",
  content: "hello",
  createdAt: 1000,
  ...over,
});

describe("mergeRealtimeMessage", () => {
  it("ignores a message already in the list", () => {
    const list = [msg({ id: "m1" })];
    expect(mergeRealtimeMessage(list, msg({ id: "m1" }))).toBe(list);
  });

  it("appends a peer's message", () => {
    const out = mergeRealtimeMessage([msg({ id: "m1" })], msg({ id: "m2", createdAt: 2000 }));
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("replaces the sender's own optimistic copy instead of showing it twice", () => {
    // In a shared session your own message comes back over the subscription
    // under its real id, so it used to sit next to the copy drawn when you
    // pressed send until the refetch cleared it up.
    const out = mergeRealtimeMessage(
      [msg({ id: optimisticId(), content: "how many vacation days?" })],
      msg({ id: "server-1", content: "how many vacation days?", createdAt: 2000 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("server-1");
  });

  it("keeps an optimistic message that says something else", () => {
    const out = mergeRealtimeMessage(
      [msg({ id: optimisticId(), content: "mine" })],
      msg({ id: "server-1", content: "theirs", createdAt: 2000 }),
    );
    expect(out.map((m) => m.content)).toEqual(["mine", "theirs"]);
  });

  it("does not mistake an assistant reply for an identical question", () => {
    const out = mergeRealtimeMessage(
      [msg({ id: optimisticId(), role: "user", content: "ok" })],
      msg({ id: "server-1", role: "assistant", content: "ok", createdAt: 2000 }),
    );
    expect(out).toHaveLength(2);
  });

  it("inserts by timestamp rather than always at the end", () => {
    // A local message carries this browser's clock, which can run ahead of the
    // database's — appending blindly would show the transcript in an order it
    // will not still be in after the next refetch.
    const out = mergeRealtimeMessage(
      [msg({ id: "m1", createdAt: 1000 }), msg({ id: "m3", createdAt: 3000 })],
      msg({ id: "m2", createdAt: 2000 }),
    );
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
