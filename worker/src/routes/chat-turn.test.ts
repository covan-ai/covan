import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildToolContext } from "./chat-turn";
import type { ToolEnv } from "../lib/harness/registry";

/**
 * The per-turn scratch space, and the precedent for it going missing.
 *
 * `message_steps.tokens` was added in 0060 and is NULL on every row ever
 * written, because nothing filled it. A map the tools write to but nobody
 * creates is the same failure: every guard that reads it silently does nothing,
 * and the build stays green. So each one is asserted here, at the only place
 * that constructs them.
 */
describe("buildToolContext", () => {
  const ctx = () =>
    buildToolContext({
      db: {} as SupabaseClient,
      env: {} as ToolEnv,
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      runtimeLimit: { hit: false },
    });

  it("carries the three per-turn stores the catalogue tools write to", () => {
    const built = ctx();
    expect(built.searchMemo).toBeInstanceOf(Map);
    expect(built.offeredSlugs).toBeInstanceOf(Set);
    // Read by `run_tool` to refuse a malformed call before Composio bills for
    // it. Undefined here means that check never runs. #195.
    expect(built.offeredSchemas).toBeInstanceOf(Map);
  });
});
