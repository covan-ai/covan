import { describe, it, expect } from "vitest";
import {
  reportBundleMarker,
  reportBundleName,
  findReportBundle,
  parseReportCommand,
} from "./reports";
import { chatBundleMarker } from "./chat-uploads";
import type { Bundle } from "./api-client";

const bundle = (id: string, name: string, description: string | null): Bundle => ({
  id,
  name,
  description,
  documentCount: 0,
  createdAt: 0,
});

describe("reportBundleName", () => {
  it("names the bundle after the agent, for a human reading the Knowledge tab", () => {
    expect(reportBundleName("Ops Assistant")).toBe("Ops Assistant — reports");
  });
});

describe("findReportBundle", () => {
  const agentId = "agent-1";
  const mine = bundle("b1", "Ops Assistant — reports", reportBundleMarker(agentId));

  it("finds this agent's report bundle by its marker", () => {
    expect(findReportBundle([mine], agentId)).toBe(mine);
  });

  it("does not take another agent's report bundle", () => {
    const theirs = bundle("b2", "Support — reports", reportBundleMarker("agent-2"));
    expect(findReportBundle([theirs], agentId)).toBeNull();
  });

  it("does not take the same agent's chat-uploads bundle", () => {
    // Both markers are per-agent and both live in `description`. What keeps a
    // report out of the drop-a-file-in-chat bundle is the prefix, so this is
    // the assertion that the two features cannot land on each other.
    const uploads = bundle("b3", "Ops Assistant — chat uploads", chatBundleMarker(agentId));
    expect(findReportBundle([uploads], agentId)).toBeNull();
  });

  it("ignores a hand-made bundle that merely looks like one", () => {
    const lookalike = bundle("b4", "Ops Assistant — reports", null);
    expect(findReportBundle([lookalike], agentId)).toBeNull();
  });

  it("returns null when the agent has never had a report written", () => {
    expect(findReportBundle([], agentId)).toBeNull();
  });
});

describe("parseReportCommand", () => {
  it("takes everything after the command as the instruction", () => {
    expect(parseReportCommand("/report write up the quarter")).toEqual({
      instruction: "write up the quarter",
    });
  });

  it("keeps an instruction written in any language", () => {
    expect(parseReportCommand("/report bu çeyreği yönetime özetle")).toEqual({
      instruction: "bu çeyreği yönetime özetle",
    });
  });

  it("answers a bare command with an empty instruction, not with nothing", () => {
    // The two are different answers and the caller treats them differently:
    // null sends the line as an ordinary message, an empty instruction opens
    // the dialog to ask for one.
    expect(parseReportCommand("/report")).toEqual({ instruction: "" });
    expect(parseReportCommand("/report   ")).toEqual({ instruction: "" });
  });

  it("reads the command however it was capitalised", () => {
    expect(parseReportCommand("/Report Q3")).toEqual({ instruction: "Q3" });
  });

  it("takes an instruction written on the next line", () => {
    expect(parseReportCommand("/report\nwrite up the quarter")).toEqual({
      instruction: "write up the quarter",
    });
  });

  it("is not fooled by a longer word that starts the same way", () => {
    expect(parseReportCommand("/reporting is broken")).toBeNull();
  });

  it("only counts at the start of the message", () => {
    // Otherwise a message that merely mentions the command would be swallowed
    // instead of sent.
    expect(parseReportCommand("remind me: /report is a thing now")).toBeNull();
  });

  it("leaves an ordinary message alone", () => {
    expect(parseReportCommand("how did Q3 go?")).toBeNull();
    expect(parseReportCommand("")).toBeNull();
  });
});
