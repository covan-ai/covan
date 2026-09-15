import { describe, it, expect } from "vitest";
import { reportBundleMarker, reportBundleName, findReportBundle } from "./reports";
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
