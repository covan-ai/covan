import { describe, it, expect } from "vitest";
import {
  JOBS,
  SETUP,
  TOOLS,
  composioLogoPath,
  defaultAssistantName,
  firstConnectableTool,
  personaFor,
  searchTools,
  toolById,
} from "./onboarding-config";
import { firstWeekSteps } from "./first-week";

/**
 * The config is data, and data drifts. These pin the shapes the screens and
 * the worker rely on: ids that are unique and storable, a persona written
 * from the jobs picked, and a setup entry for every step the done-state knows
 * about.
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
  it("offers jobs with ids the API will store", () => {
    for (const job of JOBS) expect(job.id).toMatch(/^[a-z][a-z0-9_-]{0,39}$/);
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
  });

  it("writes the persona from the workspace and the jobs picked, in one paragraph", () => {
    expect(personaFor({ workspaceName: "Acme", jobs: ["answer-questions", "draft-replies"] })).toBe(
      "You work for Acme. You answer customer questions using the documents in Knowledge and draft replies for the team to check and send. Be brief and warm, quote the document that applies, and ask a person when a case is unclear rather than guessing.",
    );
    expect(personaFor({ workspaceName: null, jobs: [] })).toMatch(
      /^You work for the team\. You help the team with whatever it asks/,
    );
  });

  it("names the assistant after the person, or after nobody", () => {
    expect(defaultAssistantName("Ada")).toBe("Ada's assistant");
    expect(defaultAssistantName("  ")).toBe("Your assistant");
    expect(defaultAssistantName(null)).toBe("Your assistant");
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
