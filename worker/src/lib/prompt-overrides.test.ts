import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineEnv } from "../types";
import type { AgentTool } from "./harness/registry";
import {
  CONCISION_INSTRUCTIONS,
  DEFAULT_PERSONA,
  DOCUMENT_INSTRUCTIONS,
  buildSystemPrefix,
} from "./prompt";
import {
  NO_OVERRIDES,
  promptOverrides,
  registerPromptSource,
  resetPromptSource,
  withToolDescriptions,
} from "./prompt-overrides";

const env = {} as RoutineEnv;

afterEach(() => resetPromptSource());

describe("prompt overrides", () => {
  it("are nothing at all in the open build", async () => {
    expect(await promptOverrides(env)).toBe(NO_OVERRIDES);
  });

  it("come from the source a deployment registered", async () => {
    registerPromptSource(async () => ({ parts: { concision: "Be brief." }, tools: {} }));
    expect((await promptOverrides(env)).parts.concision).toBe("Be brief.");
  });

  it("fall back to the defaults when the source fails, rather than failing the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPromptSource(async () => {
      throw new Error("database is down");
    });
    expect(await promptOverrides(env)).toBe(NO_OVERRIDES);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("a system prefix with overrides", () => {
  const base = { persona: null, mode: "normal" as const, docNames: [] };

  it("is byte for byte the default prefix when nothing was overridden", () => {
    expect(buildSystemPrefix({ ...base, overrides: NO_OVERRIDES })).toBe(buildSystemPrefix(base));
  });

  it("replaces the part it names and nothing else", () => {
    const out = buildSystemPrefix({
      ...base,
      overrides: { parts: { concision: "Answer in one line." }, tools: {} },
    });
    expect(out).toContain("Answer in one line.");
    expect(out).not.toContain(CONCISION_INSTRUCTIONS);
    expect(out.startsWith(DEFAULT_PERSONA)).toBe(true);
  });

  it("never replaces a persona the agent's owner wrote", () => {
    const out = buildSystemPrefix({
      ...base,
      persona: "You are Ada, the finance team's analyst.",
      overrides: { parts: { default_persona: "You are a deployment's voice." }, tools: {} },
    });
    expect(out.startsWith("You are Ada")).toBe(true);
    expect(out).not.toContain("deployment's voice");
  });

  it("reaches the mode a document is written in", () => {
    const out = buildSystemPrefix({
      ...base,
      mode: "document",
      overrides: { parts: { document: "Write it plainly." }, tools: {} },
    });
    expect(out).toContain("Write it plainly.");
    expect(out).not.toContain(DOCUMENT_INSTRUCTIONS);
  });
});

describe("tool descriptions with overrides", () => {
  const tools = [
    { name: "run_tool", description: "Run one operation." },
    { name: "find_tool", description: "Search the catalogue." },
  ] as AgentTool[];

  it("hands back the same tools when nothing was reworded", () => {
    expect(withToolDescriptions(tools, NO_OVERRIDES)).toBe(tools);
  });

  it("rewords only the tool it names, and leaves the original untouched", () => {
    const out = withToolDescriptions(tools, {
      parts: {},
      tools: { run_tool: "Run one operation, narrowly." },
    });
    expect(out[0].description).toBe("Run one operation, narrowly.");
    expect(out[1]).toBe(tools[1]);
    expect(tools[0].description).toBe("Run one operation.");
  });

  it("ignores an empty replacement rather than sending a tool with no description", () => {
    const out = withToolDescriptions(tools, { parts: {}, tools: { run_tool: "  " } });
    expect(out[0].description).toBe("Run one operation.");
  });
});
