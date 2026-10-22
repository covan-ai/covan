import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, settingsRoutes } from "./settings-pages";

const ROUTES = "src/routes/";

/** `_authed.settings.general.tsx` -> `/settings/general`; redirects excluded. */
function settingsPageFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => /^_authed\.settings\.[a-z-]+\.tsx$/.test(f) && !f.endsWith(".test.tsx"))
    .filter((f) => f !== "_authed.settings.index.tsx")
    .filter((f) => !readFileSync(`${ROUTES}${f}`, "utf8").includes("throw redirect("))
    .map((f) => `/settings/${f.replace(/^_authed\.settings\./, "").replace(/\.tsx$/, "")}`)
    .sort();
}

describe("the settings sub-nav", () => {
  it("lists every settings page there is, and only those", () => {
    expect(settingsRoutes().sort()).toEqual(settingsPageFiles());
  });

  it("is the boards' three groups, Members pointing at Team", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Workspace", "My account", "Help"]);
    expect(SETTINGS_GROUPS[0]!.items.find((i) => i.label === "Members")?.href).toBe("/team");
  });
});
