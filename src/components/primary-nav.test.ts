import { describe, it, expect } from "vitest";
import { pageLabel, primaryNavMatch } from "./primary-nav";

describe("the sidebar's idea of where you are", () => {
  // `/settings/members` is under two entries. The longer one wins, or the Team
  // page would light Settings too and the context bar would call it Settings.
  it("calls the members page Team, not Settings", () => {
    expect(pageLabel("/settings/members")).toBe("Team");
    expect(primaryNavMatch("/settings/members")?.to).toBe("/settings/members");
  });

  it("calls every other settings page Settings", () => {
    expect(pageLabel("/settings")).toBe("Settings");
    expect(pageLabel("/settings/account")).toBe("Settings");
    expect(pageLabel("/settings/workspace")).toBe("Settings");
  });

  it("matches a page and what is under it, and falls back to the brand", () => {
    expect(pageLabel("/app")).toBe("Home");
    expect(pageLabel("/knowledge/x")).toBe("Knowledge");
    expect(pageLabel("/apps")).toBe("Covan");
    expect(pageLabel("/nowhere")).toBe("Covan");
  });
});
