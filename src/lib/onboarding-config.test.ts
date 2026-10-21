import { describe, it, expect } from "vitest";
import {
  INTRO,
  ROLES,
  SETUP,
  STEPS,
  TOOLS,
  PURPOSES,
  composioLogoPath,
  defaultAssistantName,
  firstConnectableTool,
  searchTools,
  templateFor,
  toolById,
} from "./onboarding-config";
import { EMOJIS, PERSONA_TEMPLATES } from "./agent-meta";
import { firstWeekSteps } from "./first-week";

/**
 * The config is data, and data drifts. These pin the shapes the screens and
 * the worker rely on: ids that are unique and storable, a headline with one
 * brand word, a persona template behind every role and purpose, and a setup
 * entry for every step the done-state knows about.
 */

describe("the tool catalogue", () => {
  it("has no two tools sharing an id", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses ids the API will store", () => {
    // worker/src/lib/onboarding.ts TOOL_SLUG
    for (const t of TOOLS) expect(t.id).toMatch(/^[a-z0-9][a-z0-9_]{0,39}$/);
  });

  it("holds its own marks for the sources we draw", () => {
    expect(toolById("notion")?.logo).toEqual({ kind: "provider", provider: "notion" });
    expect(toolById("google_drive")?.logo).toEqual({ kind: "provider", provider: "google_drive" });
    expect(toolById("slack")?.logo).toEqual({ kind: "slack" });
  });

  it("fetches every other mark through our own logo proxy", () => {
    // The same address app-catalogue builds from a toolkit response.
    expect(composioLogoPath("gmail")).toBe(
      "/composio/logo?u=https%3A%2F%2Flogos.composio.dev%2Fapi%2Fgmail",
    );
  });

  it("searches names and keywords, case-insensitively", () => {
    expect(searchTools("CRM").map((t) => t.id)).toEqual(["hubspot", "salesforce"]);
    expect(searchTools("drive").map((t) => t.id)).toEqual(["google_drive"]);
    expect(searchTools("")).toBe(TOOLS);
    expect(searchTools("zzz")).toEqual([]);
  });
});

describe("firstConnectableTool", () => {
  it("keeps the person's order", () => {
    expect(firstConnectableTool(["notion", "gmail"])?.id).toBe("notion");
    expect(firstConnectableTool(["gmail", "notion"])?.id).toBe("gmail");
  });

  it("skips what is connected already, under the slug the connected list uses", () => {
    expect(firstConnectableTool(["google_drive", "gmail"], new Set(["googledrive"]))?.id).toBe(
      "gmail",
    );
  });

  it("skips a tool nothing can connect yet, and an id it does not know", () => {
    expect(firstConnectableTool(["whatsapp", "nope", "gmail"])?.id).toBe("gmail");
    expect(firstConnectableTool(["whatsapp"])).toBeNull();
    expect(firstConnectableTool(null)).toBeNull();
  });
});

describe("the words", () => {
  it("colours exactly one phrase of every intro headline", () => {
    for (const screen of INTRO) {
      expect(screen.headline.brand.trim().length).toBeGreaterThan(0);
    }
  });

  it("offers roles whose emoji the pickers can show", () => {
    for (const role of ROLES) expect(EMOJIS).toContain(role.emoji);
  });

  it("has a persona template behind every role and purpose", () => {
    const ids = PERSONA_TEMPLATES.map((t) => t.id);
    for (const role of ROLES) expect(ids).toContain(role.templateId);
    for (const purpose of PURPOSES) expect(ids).toContain(purpose.templateId);
  });

  it("starts from the role's template first, then the purpose's, then the general one", () => {
    expect(templateFor({ assistantRole: "quill", purpose: "sales" }).id).toBe("writer");
    expect(templateFor({ assistantRole: "custom", purpose: "sales" }).id).toBe("sales");
    expect(templateFor({ assistantRole: null, purpose: null }).id).toBe("tutor");
  });

  it("names the assistant after the person, or after nobody", () => {
    expect(defaultAssistantName("Ada")).toBe("Ada's assistant");
    expect(defaultAssistantName("  ")).toBe("Your assistant");
    expect(defaultAssistantName(null)).toBe("Your assistant");
  });

  it("asks the team step only of a team", () => {
    const team = STEPS.find((s) => s.id === "team")!;
    expect(team.when?.({ mode: "team" } as never)).toBe(true);
    expect(team.when?.({ mode: "solo" } as never)).toBe(false);
  });
});

describe("the setup list", () => {
  it("has an entry for every step the done-state derives, and no other", () => {
    const derived = firstWeekSteps({
      agents: [],
      sessions: [],
      memberCount: 1,
      routineCount: 0,
    }).map((s) => s.key);
    expect(SETUP.map((s) => s.key).sort()).toEqual([...derived].sort());
  });

  it("rewards at least one step", () => {
    expect(SETUP.some((s) => s.rewarded)).toBe(true);
  });

  it("names the tool it offers to connect", () => {
    const connect = SETUP.find((s) => s.key === "connect")!;
    expect(connect.label({ toolName: "Gmail", mode: null })).toBe("Connect Gmail");
    expect(connect.label({ toolName: null, mode: null })).toBe("Connect an app");
  });

  it("asks a solo person to share rather than to invite", () => {
    const team = SETUP.find((s) => s.key === "team")!;
    expect(team.coach({ toolName: null, mode: "solo" }).id).toBe("share-agent");
    expect(team.coach({ toolName: null, mode: "team" }).id).toBe("invite-member");
  });
});
