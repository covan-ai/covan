import { describe, expect, it } from "vitest";
import {
  KICKOFF_ASK,
  KICKOFF_RULES,
  NOT_YET_CONNECTABLE,
  kickoffNote,
  onboardingKickoff,
  toolLabel,
  type KickoffFacts,
} from "./onboarding-kickoff";

const FACTS: KickoffFacts = {
  firstName: "Ada",
  assistantName: "Desk",
  tools: ["gmail", "notion"],
  purpose: "sales",
  mode: "team",
};

describe("toolLabel", () => {
  it("names the tools the first run offers", () => {
    expect(toolLabel("gmail")).toBe("Gmail");
    expect(toolLabel("googlecalendar")).toBe("Google Calendar");
    expect(toolLabel("google_drive")).toBe("Google Drive");
    expect(toolLabel("github")).toBe("GitHub");
    expect(toolLabel("microsoftteams")).toBe("Microsoft Teams");
    expect(toolLabel("whatsapp")).toBe("WhatsApp");
  });

  it("title-cases a slug it has no word for", () => {
    expect(toolLabel("pipedrive")).toBe("Pipedrive");
    expect(toolLabel("zoho_crm")).toBe("Zoho Crm");
  });
});

describe("kickoffNote", () => {
  it("carries the facts the first run recorded", () => {
    const note = kickoffNote(FACTS);
    expect(note).toContain("Their first name: Ada.");
    expect(note).toContain("Your name: Desk.");
    expect(note).toContain("mostly help with: sales.");
    expect(note).toContain("their team");
    expect(note).toContain("Gmail, Notion. None is connected yet.");
  });

  it("proposes the first tool the person picked, and only that one", () => {
    const note = kickoffNote(FACTS);
    expect(note).toContain("The one next step to propose: connecting Gmail");
    expect(note).not.toContain("connecting Notion");
  });

  it("falls back to a document when no tool was picked", () => {
    const note = kickoffNote({ ...FACTS, tools: [] });
    expect(note).toContain("did not name any apps");
    expect(note).toContain("adding one document the team relies on");
    expect(note).not.toContain("connecting");
  });

  it("proposes the first tool that can be connected, not the first named", () => {
    expect([...NOT_YET_CONNECTABLE]).toEqual(["whatsapp"]);
    const note = kickoffNote({ ...FACTS, tools: ["whatsapp", "gmail", "notion"] });
    // Still listed, in the person's order…
    expect(note).toContain("WhatsApp, Gmail, Notion. None is connected yet.");
    // …named as not available, and never the proposal.
    expect(note).toContain("Not available in Covan yet: WhatsApp. Say so in one clause");
    expect(note).toContain("do not propose connecting it.");
    expect(note).toContain("The one next step to propose: connecting Gmail");
    expect(note).not.toContain("connecting WhatsApp");
  });

  it("falls back to a document when nothing named can be connected yet", () => {
    const note = kickoffNote({ ...FACTS, tools: ["whatsapp"] });
    expect(note).toContain("Not available in Covan yet: WhatsApp.");
    expect(note).toContain("adding one document the team relies on");
    expect(note).not.toContain("The one next step to propose: connecting");
  });

  it("says nothing about availability when every tool named can be connected", () => {
    expect(kickoffNote(FACTS)).not.toContain("Not available in Covan yet");
  });

  it("greets without a name when the profile has none", () => {
    const note = kickoffNote({ ...FACTS, firstName: null });
    expect(note).toContain("greet them without a name");
    expect(note).not.toContain("Ada");
  });

  it("ends on the rules: the promise, the plan first, the length", () => {
    const note = kickoffNote(FACTS);
    expect(note.endsWith(KICKOFF_RULES)).toBe(true);
    expect(note).toContain("every conversation stays private");
    expect(note).toContain("show them the plan before you act");
    expect(note).toContain("under 120 words");
    expect(note).toContain("nothing is connected yet");
  });

  it("lets a deployment reword the rules and nothing else", () => {
    const note = kickoffNote(FACTS, "Say hello in Turkish.");
    expect(note.endsWith("Say hello in Turkish.")).toBe(true);
    expect(note).not.toContain("under 120 words");
    expect(note).toContain("Your name: Desk.");
  });
});

/** A caller's client answering the two reads the kickoff makes. */
function dbWith(
  onboarding: Record<string, unknown> | null,
  profile: Record<string, unknown> | null = { name: "Ada Lovelace" },
  fail: "onboarding" | "profile" | null = null,
) {
  const reads: string[] = [];
  const db = {
    from: (table: string) => {
      reads.push(table);
      const answer =
        table === "user_onboarding"
          ? fail === "onboarding"
            ? { data: null, error: { code: "42501" } }
            : { data: onboarding, error: null }
          : fail === "profile"
            ? { data: null, error: { code: "42501" } }
            : { data: profile, error: null };
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => answer }),
        }),
      };
    },
  };
  return { db: db as never, reads };
}

const ROW = {
  completed_at: "2026-10-21T10:00:00Z",
  assistant_name: "Desk",
  tools: ["gmail", "notion"],
  purpose: "sales",
  mode: "team",
  agent_id: "agent-1",
};

describe("onboardingKickoff", () => {
  it("opens for the agent the first run made, with the person's first name", async () => {
    const { db } = dbWith(ROW);

    const intro = await onboardingKickoff(db, "user-1", "agent-1");

    expect(intro?.ask).toBe(KICKOFF_ASK);
    expect(intro?.note).toContain("Their first name: Ada.");
    expect(intro?.note).toContain("Your name: Desk.");
    expect(intro?.note).toContain("connecting Gmail");
  });

  it("refuses a first run that is not finished", async () => {
    const { db } = dbWith({ ...ROW, completed_at: null });
    expect(await onboardingKickoff(db, "user-1", "agent-1")).toBeNull();
  });

  it("refuses an agent the first run did not make", async () => {
    const { db } = dbWith({ ...ROW, agent_id: "agent-2" });
    expect(await onboardingKickoff(db, "user-1", "agent-1")).toBeNull();
  });

  it("refuses when there is no row at all", async () => {
    const { db } = dbWith(null);
    expect(await onboardingKickoff(db, "user-1", "agent-1")).toBeNull();
  });

  it("refuses rather than fails when the read fails", async () => {
    const { db } = dbWith(ROW, { name: "Ada" }, "onboarding");
    expect(await onboardingKickoff(db, "user-1", "agent-1")).toBeNull();
  });

  it("still opens, nameless, when only the profile read fails", async () => {
    const { db } = dbWith(ROW, null, "profile");

    const intro = await onboardingKickoff(db, "user-1", "agent-1");

    expect(intro).not.toBeNull();
    expect(intro?.note).toContain("greet them without a name");
  });

  it("keeps the order the person picked their tools in", async () => {
    const { db } = dbWith({ ...ROW, tools: ["notion", "gmail"] });

    const intro = await onboardingKickoff(db, "user-1", "agent-1");

    expect(intro?.note).toContain("Notion, Gmail.");
    expect(intro?.note).toContain("connecting Notion");
  });
});
