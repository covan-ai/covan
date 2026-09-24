import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolEnv } from "./registry";
import { capabilitiesFor } from "./available";

/**
 * Which tools an agent is actually offered, and why the answer is three
 * questions rather than one.
 *
 * A tool the deployment cannot run is a tool the model can call and nothing
 * can answer. A tool with nothing in this workspace to point at is worse than
 * useless — it spends tokens and invites the model to invent a connection id.
 * And RLS is not asked here at all: both reads go through the caller's own
 * client, so a connection in another workspace was never in the list.
 */

const FULL: ToolEnv = {
  ALLOWED_ORIGIN: "https://app.covan.test",
  ROUTINE_SECRET_KEY: "k",
  RESEND_API_KEY: "re",
  RESEND_FROM: "R <r@e.com>",
} as ToolEnv;

function dbWith(connections: unknown[], channels: unknown[]): SupabaseClient {
  return {
    from: (table: string) =>
      table === "tool_connections"
        ? {
            // Two `eq`s, because `listConnections` filters by workspace and by
            // status: a connection that is still at a consent screen must not
            // reach the model, which would name it, call it, and spend a step
            // of the budget being told it is not finished.
            select: () => ({
              eq: () => ({
                eq: () => ({ order: async () => ({ data: connections, error: null }) }),
              }),
            }),
          }
        : { select: () => ({ eq: async () => ({ data: channels, error: null }) }) },
  } as unknown as SupabaseClient;
}

const CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Covan Supabase",
  transport: "sql",
  base_url: "https://proj.supabase.co/rest/v1",
  allowed_methods: ["GET"],
  config: {},
};

const CHANNEL = { id: "chan-1", kind: "email", label: "a••••a@covan.test" };

const ask = (db: SupabaseClient, env: ToolEnv = FULL) =>
  capabilitiesFor({ db, env, workspaceId: "ws-1", userId: "user-1" });

describe("capabilitiesFor", () => {
  it("offers only the tool that needs nothing when the workspace has nothing", async () => {
    const { tools, manifest } = await ask(dbWith([], []));
    expect(tools.map((t) => t.name)).toEqual(["search_documents"]);
    // No manifest at all, so an agent with no connections and no channels
    // gets exactly the prompt it got before tools existed.
    expect(manifest).toBe("");
  });

  it("offers the catalogue search to an empty workspace, because that is what it is for", async () => {
    // The one tool in the registry with no `needs`, and deliberately so: the
    // answer "you would need to connect Linear first" is only available to
    // something that can see the unconnected half of the catalogue. Still
    // gated by `isConfigured`, which is why the case above is unaffected.
    const { tools } = await ask(dbWith([], []), { ...FULL, COMPOSIO_API_KEY: "ck" } as ToolEnv);
    expect(tools.map((t) => t.name)).toEqual(["search_documents", "find_tool"]);
  });

  it("adds the connection tools, and the ids they take, once there is one", async () => {
    const { tools, manifest } = await ask(dbWith([CONNECTION], []));
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "describe_connection",
      "query_database",
      "http_request",
    ]);
    expect(manifest).toContain("conn-1");
    expect(manifest).toContain("Covan Supabase");
    expect(manifest).toContain("Never guess an id");
  });

  it("adds the sending tools, and says an address is not an option", async () => {
    const { tools, manifest } = await ask(dbWith([], [CHANNEL]));
    expect(tools.map((t) => t.name)).toContain("send_email");
    expect(tools.map((t) => t.name)).toContain("schedule_job");
    expect(manifest).toContain("chan-1");
    expect(manifest).toContain("cannot send to an address");
  });

  it("leaves out a tool this deployment cannot run, however many rows it has", async () => {
    const { tools } = await ask(dbWith([], [CHANNEL]), {
      ALLOWED_ORIGIN: "https://app.covan.test",
    } as ToolEnv);
    // No Resend key: sending is not offered. Scheduling still is — it creates
    // a routine and does not send anything itself.
    expect(tools.map((t) => t.name)).not.toContain("send_email");
    expect(tools.map((t) => t.name)).toContain("schedule_job");
  });

  /**
   * Nobody is watching a scheduled run, so the two tools that need a person
   * are not offered — and the read behind them is not made either, which on
   * the cron Worker is a subrequest the tick keeps.
   */
  it("offers no sending tools, and reads no channels, for a run nobody is watching", async () => {
    let channelsRead = false;
    const db = {
      from: (table: string) => {
        if (table === "delivery_channels") {
          channelsRead = true;
          return { select: () => ({ eq: async () => ({ data: [CHANNEL], error: null }) }) };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ order: async () => ({ data: [CONNECTION], error: null }) }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;

    const { tools, manifest } = await capabilitiesFor({
      db,
      env: FULL,
      workspaceId: "ws-1",
      userId: "user-1",
      surface: "schedule",
    });

    expect(channelsRead).toBe(false);
    expect(tools.map((t) => t.name)).not.toContain("send_email");
    expect(tools.map((t) => t.name)).not.toContain("schedule_job");
    // What it CAN do is still named, because that is what it is there for.
    expect(tools.map((t) => t.name)).toContain("query_database");
    expect(manifest).toContain("Covan Supabase");
  });

  it("still answers when the connection lookup fails, rather than failing the turn", async () => {
    const broken = {
      from: (table: string) =>
        table === "tool_connections"
          ? {
              select: () => ({
                eq: () => ({
                  order: async () => ({ data: null, error: { message: "gone" } }),
                }),
              }),
            }
          : { select: () => ({ eq: async () => ({ data: [], error: null }) }) },
    } as unknown as SupabaseClient;
    const { tools } = await ask(broken);
    expect(tools.map((t) => t.name)).toEqual(["search_documents"]);
  });
});
