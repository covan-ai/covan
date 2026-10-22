import { describe, expect, it } from "vitest";
import { shellFor } from "./shell-context";

describe("which frame a path is drawn in", () => {
  it("draws the welcome flow and a print view bare", () => {
    expect(shellFor("/welcome")).toEqual({ chrome: "bare" });
    expect(shellFor("/welcome/anything")).toEqual({ chrome: "bare" });
    expect(shellFor("/documents/d1/print")).toEqual({ chrome: "bare" });
  });

  it("draws everything else in the shell, with the agent the path is inside", () => {
    expect(shellFor("/app")).toEqual({ chrome: "app" });
    expect(shellFor("/settings/general")).toEqual({ chrome: "app" });
    expect(shellFor("/documents/d1")).toEqual({ chrome: "app" });
    expect(shellFor("/agents/a1/chat")).toEqual({ chrome: "app", agentId: "a1" });
    expect(shellFor("/agents/a%201")).toEqual({ chrome: "app", agentId: "a 1" });
  });
});
