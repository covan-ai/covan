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
  /**
   * A client that answers the two reads this makes.
   *
   * Both go to `message_steps` and they want different rows, so the mock
   * answers on the filter the code applied: the searches read narrows to
   * `find_tool`, and the offerings read does not. `null` means the database
   * refuses — the shape a deployment has before `0066` is applied by hand,
   * which is a real state rather than a hypothetical one.
   */
  const dbWith = (
    offered: Array<{ offered: string[] }> | null,
    searches: Array<{ request: Record<string, unknown>; offered: string[] | null }> | null = [],
  ) => {
    const chain: Record<string, unknown> = {};
    let findTool = false;
    for (const method of ["select", "not", "order"]) {
      chain[method] = () => chain;
    }
    chain.eq = (column: string, value: unknown) => {
      if (column === "tool" && value === "find_tool") findTool = true;
      return chain;
    };
    chain.limit = async () => {
      const rows = findTool ? searches : offered;
      return rows === null
        ? { data: null, error: { message: "column does not exist" } }
        : { data: rows, error: null };
    };
    return { from: () => ({ ...chain }) } as unknown as SupabaseClient;
  };

  const ctx = (db: SupabaseClient = dbWith([])) =>
    buildToolContext({
      db,
      env: {} as ToolEnv,
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      runtimeLimit: { hit: false },
    });

  it("carries the per-turn stores the catalogue tools write to", async () => {
    const built = await ctx();
    expect(built.searchMemo).toBeInstanceOf(Map);
    expect(built.offeredSlugs).toBeInstanceOf(Set);
    // Read by `find_tool` to recognise a search this conversation already paid
    // for (#216). Undefined here means every repeat buys the catalogue again.
    expect(built.priorSearches).toBeInstanceOf(Map);
    // Read by `run_tool` to refuse a malformed call before Composio bills for
    // it (#195), and to tell the approval card what the operation does (#201).
    // Undefined here means neither happens.
    expect(built.offeredOperations).toBeInstanceOf(Map);
  });

  it("seeds the allowed slugs with what this conversation was already shown", async () => {
    // The whole point of 0066. Empty here is what let a third question invent
    // GITHUB_GET_PULL_REQUESTS and buy a billed 404 to find out it does not
    // exist — `run_tool`'s guard stands down on an empty set.
    const built = await ctx(
      dbWith([
        { offered: ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST"] },
        { offered: ["GITHUB_LIST_PULL_REQUESTS", "GOOGLECALENDAR_EVENTS_LIST"] },
      ]),
    );

    // Unioned across steps, and a slug offered twice is one slug.
    expect(built.offeredSlugs).toEqual(
      new Set([
        "GITHUB_LIST_PULL_REQUESTS",
        "GITHUB_GET_A_PULL_REQUEST",
        "GOOGLECALENDAR_EVENTS_LIST",
      ]),
    );
  });

  it("falls back to an empty set when the read fails, rather than failing the turn", async () => {
    // `0066` is applied by hand, so a deployment can run this code against a
    // schema without the column. An empty set is exactly the behaviour this
    // replaced, so the harness degrades to it instead of losing the reply.
    const built = await ctx(dbWith(null, null));
    expect(built.offeredSlugs).toEqual(new Set());
    expect(built.priorSearches).toEqual(new Map());
  });

  it("seeds the searches this conversation has already paid for", async () => {
    // #216: the offered set crossed turns and the question that produced it did
    // not, so turn two re-ran turn one's search to be handed candidates it was
    // already allowed to call.
    const built = await ctx(
      dbWith(
        [{ offered: ["GITHUB_LIST_PULL_REQUESTS"] }],
        [
          {
            request: { query: "list pull requests", toolkit: "github" },
            offered: ["GITHUB_LIST_PULL_REQUESTS"],
          },
        ],
      ),
    );

    expect([...(built.priorSearches ?? new Map()).values()]).toEqual([
      ["GITHUB_LIST_PULL_REQUESTS"],
    ]);
  });

  it("reads the two halves at the same time, not one after the other", async () => {
    // Both are on the critical path of every turn, and they are independent.
    const seen: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      seen.push(name);
      return { data: [], error: null };
    };
    const db = {
      from: () => {
        const chain: Record<string, unknown> = {};
        let findTool = false;
        for (const method of ["select", "not", "order"]) chain[method] = () => chain;
        chain.eq = (column: string, value: unknown) => {
          if (column === "tool" && value === "find_tool") findTool = true;
          return chain;
        };
        chain.limit = () => (findTool ? slow("searches", 5)() : slow("offerings", 15)());
        return chain;
      },
    } as unknown as SupabaseClient;

    await ctx(db);

    // Sequential would finish in the order they were started.
    expect(seen).toEqual(["searches", "offerings"]);
  });
});
