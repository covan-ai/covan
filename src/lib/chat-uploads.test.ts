import { describe, it, expect } from "vitest";
import { chatBundleMarker, chatBundleName, findChatBundle } from "./chat-uploads";
import type { Bundle } from "./api-client";

const bundle = (id: string, name: string, description: string | null): Bundle => ({
  id,
  name,
  description,
  documentCount: 0,
  createdAt: 0,
});

describe("chatBundleName", () => {
  it("names the bundle after the agent, for a human reading the Knowledge tab", () => {
    expect(chatBundleName("Ops Assistant")).toBe("Ops Assistant — chat uploads");
  });
});

describe("findChatBundle", () => {
  const agentId = "agent-1";
  const mine = bundle("b1", "Ops Assistant — chat uploads", chatBundleMarker(agentId));

  it("finds this agent's chat bundle by its marker", () => {
    expect(findChatBundle([mine], agentId)).toBe(mine);
  });

  it("does not take another agent's chat bundle", () => {
    const theirs = bundle("b2", "Support — chat uploads", chatBundleMarker("agent-2"));
    expect(findChatBundle([theirs], agentId)).toBeNull();
  });

  it("matches on the marker, not the name, so renaming the agent keeps the bundle", () => {
    // The user renamed the agent; the bundle name is now stale but it is still
    // the same bundle, and a second one must not be created beside it.
    const renamed = bundle("b3", "Ops Assistant — chat uploads", chatBundleMarker(agentId));
    expect(findChatBundle([renamed], agentId)?.id).toBe("b3");
  });

  it("ignores a hand-made bundle that merely looks like one", () => {
    const lookalike = bundle("b4", "Ops Assistant — chat uploads", null);
    expect(findChatBundle([lookalike], agentId)).toBeNull();
  });

  it("returns null when the agent has never had a file dropped into a chat", () => {
    expect(findChatBundle([], agentId)).toBeNull();
  });
});
