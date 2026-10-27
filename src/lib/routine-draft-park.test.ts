import { beforeEach, describe, expect, it } from "vitest";
import { PARK_FOR_MS, parkDraft, takeParkedDraft, type ParkedDraft } from "./routine-draft-park";

const DRAFT: ParkedDraft = {
  agentId: "agent-1",
  name: "Reply drafts",
  runs: "schedule",
  connectionId: "",
  cron: "0 8 * * 1-5",
  timezone: "Europe/Istanbul",
  instruction: "Draft replies only.",
  fileTo: null,
  emailIds: null,
  slackId: undefined,
  inbox: true,
  model: null,
  effort: null,
  allowOff: ["conn-1"],
  browserOn: false,
};

beforeEach(() => sessionStorage.clear());

describe("a parked routine draft", () => {
  it("comes back once, for the page and template it was parked for", () => {
    parkDraft("/routines/new", "reply-drafts", DRAFT, 1_000);
    expect(takeParkedDraft("/routines/new", "reply-drafts", 2_000)).toEqual(DRAFT);
    // Taken: a reload starts from the template again.
    expect(takeParkedDraft("/routines/new", "reply-drafts", 3_000)).toBeNull();
  });

  it("is not handed to another template, and is gone after the attempt", () => {
    parkDraft("/routines/new", "reply-drafts", DRAFT, 1_000);
    expect(takeParkedDraft("/routines/new", "daily-brief", 2_000)).toBeNull();
    expect(takeParkedDraft("/routines/new", "reply-drafts", 2_000)).toBeNull();
  });

  it("is not handed back once it is stale", () => {
    parkDraft("/routines/new", "reply-drafts", DRAFT, 1_000);
    expect(takeParkedDraft("/routines/new", "reply-drafts", 1_000 + PARK_FOR_MS + 1)).toBeNull();
  });

  it("reads nothing out of something that is not a draft", () => {
    sessionStorage.setItem("covan.routine-draft", "{not json");
    expect(takeParkedDraft("/routines/new", "reply-drafts")).toBeNull();
  });
});
