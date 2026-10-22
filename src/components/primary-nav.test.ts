import { describe, it, expect } from "vitest";
import { PAGE_NAV, pageLabel, primaryNavMatch } from "./primary-nav";

describe("the sidebar's idea of where you are", () => {
  it("lists the six pages in the boards' order, Settings apart", () => {
    expect(PAGE_NAV.map((n) => n.label)).toEqual([
      "Home",
      "Inbox",
      "Threads",
      "Knowledge",
      "Routines",
      "Team",
    ]);
  });

  it("calls every settings page Settings", () => {
    expect(pageLabel("/settings")).toBe("Settings");
    expect(pageLabel("/settings/general")).toBe("Settings");
    expect(pageLabel("/settings/integrations")).toBe("Settings");
  });

  it("matches a page and what is under it, and falls back to the brand", () => {
    expect(pageLabel("/app")).toBe("Home");
    expect(pageLabel("/knowledge/x")).toBe("Knowledge");
    expect(primaryNavMatch("/routines/r1/edit")?.to).toBe("/routines");
    expect(pageLabel("/apps")).toBe("Covan");
    expect(pageLabel("/nowhere")).toBe("Covan");
  });
});
