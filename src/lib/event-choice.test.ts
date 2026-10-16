import { describe, it, expect } from "vitest";
import { eventChoiceReady } from "./event-choice";
import type { EventCatalogEntry } from "./routines-api";

const entry = (over: Partial<EventCatalogEntry> = {}): EventCatalogEntry => ({
  type: "slack.reaction_added",
  provider: "slack",
  app: "Slack",
  label: "Reaction added",
  description: "Somebody reacts to a message.",
  fields: [
    { key: "emoji", label: "Emoji", kind: "text" },
    { key: "channel", label: "Channel", kind: "text", optional: true },
  ],
  requires: { kind: "slack" },
  connected: true,
  ...over,
});

describe("eventChoiceReady", () => {
  it("needs every required field and none of the optional ones", () => {
    expect(eventChoiceReady([entry()], { type: "slack.reaction_added", config: {} })).toBe(false);
    expect(
      eventChoiceReady([entry()], { type: "slack.reaction_added", config: { emoji: "  " } }),
    ).toBe(false);
    expect(
      eventChoiceReady([entry()], { type: "slack.reaction_added", config: { emoji: "eyes" } }),
    ).toBe(true);
  });

  it("is never ready for an app that is not connected", () => {
    const choice = { type: "slack.reaction_added", config: { emoji: "eyes" } };
    expect(eventChoiceReady([entry({ connected: false })], choice)).toBe(false);
  });

  it("is not ready with nothing chosen, or a choice the catalogue no longer has", () => {
    expect(eventChoiceReady([entry()], null)).toBe(false);
    expect(eventChoiceReady([entry()], { type: "gone", config: {} })).toBe(false);
  });
});
