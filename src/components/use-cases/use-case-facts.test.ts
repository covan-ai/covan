import { describe, expect, it } from "vitest";
import { findUseCase, type UseCase } from "@/lib/use-cases";
import { cardState, type CardFacts } from "./use-case-facts";

function card(id: string): UseCase {
  const u = findUseCase(id);
  if (!u) throw new Error(`no use case ${id}`);
  return u;
}

/** A workspace where every requirement holds and nothing is connected. */
function facts(over: Partial<CardFacts> = {}): CardFacts {
  return {
    agentDocumentCount: 3,
    isAdmin: true,
    gapReportEnabled: true,
    memberCount: 4,
    connected: new Set(),
    sources: new Set(),
    agent: { name: "Support", webSearch: true },
    ...over,
  };
}

describe("cardState", () => {
  it("names each connection group that is missing, by its apps", () => {
    expect(cardState(card("daily-brief"), facts())).toEqual({
      kind: "ready",
      notes: ["Gmail or Outlook not connected", "Google Calendar or Outlook not connected"],
      schedule: "Weekdays 08:00",
    });
  });

  it("counts a group as connected when any one of its apps is", () => {
    const state = cardState(card("daily-brief"), facts({ connected: new Set(["outlook"]) }));
    expect(state).toMatchObject({ kind: "ready", notes: [] });
  });

  it("says a card changes things, after what is missing", () => {
    expect(cardState(card("reply-drafts"), facts())).toMatchObject({
      notes: ["Gmail not connected", "Changes things in Gmail"],
    });
    expect(cardState(card("reply-drafts"), facts({ connected: new Set(["gmail"]) }))).toMatchObject(
      { notes: ["Changes things in Gmail"] },
    );
  });

  it("names a synced source that is not there", () => {
    expect(cardState(card("notion-week"), facts())).toMatchObject({
      notes: ["Notion not connected"],
    });
    expect(cardState(card("notion-week"), facts({ sources: new Set(["notion"]) }))).toMatchObject({
      notes: [],
    });
  });

  it("says a card uses a browser", () => {
    expect(cardState(card("competitor-watch"), facts())).toMatchObject({
      notes: ["Uses a browser"],
    });
  });

  it("asks for web search only when the agent has it off", () => {
    expect(cardState(card("industry-news"), facts())).toMatchObject({ notes: [] });
    expect(
      cardState(card("industry-news"), facts({ agent: { name: "Support", webSearch: false } })),
    ).toMatchObject({ notes: ["Needs web search on Support"] });
  });

  it("is blocked by the first unmet requirement, with its reason and no notes", () => {
    const state = cardState(card("gap-report"), facts({ isAdmin: false, gapReportEnabled: false }));
    expect(state.kind).toBe("blocked");
    expect(state).toEqual({
      kind: "blocked",
      reason: expect.stringMatching(/^Only an admin of this workspace/),
    });
  });

  it("blocks the first week until the agent has something to cover", () => {
    expect(cardState(card("first-week"), facts({ agentDocumentCount: 0 }))).toMatchObject({
      kind: "blocked",
      reason: expect.stringMatching(/^Upload something to this agent first/),
    });
  });

  it("says when a card runs: a series, an event, a monthly cron, an agent", () => {
    expect(cardState(card("first-week"), facts())).toMatchObject({
      schedule: "Ends after 7 mornings",
    });
    expect(cardState(card("new-booking"), facts())).toMatchObject({ schedule: "When it happens" });
    expect(cardState(card("subscriptions"), facts())).toMatchObject({
      schedule: "1st of month",
    });
    expect(cardState(card("researcher"), facts())).toMatchObject({
      kind: "ready",
      schedule: "Agent",
    });
  });
});
