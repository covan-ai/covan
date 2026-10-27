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
                or: () => ({
                  eq: () => ({ order: async () => ({ data: connections, error: null }) }),
                }),
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
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "list_documents",
      "continue_later",
      "ask_person",
      "remember",
      "covan_guide",
    ]);
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
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "list_documents",
      "find_tool",
      "continue_later",
      "ask_person",
      "remember",
      "covan_guide",
    ]);
  });

  it("adds the connection tools, and the ids they take, once there is one", async () => {
    const { tools, manifest } = await ask(dbWith([CONNECTION], []));
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "list_documents",
      "describe_connection",
      "query_database",
      "continue_later",
      "ask_person",
      "remember",
      "covan_guide",
    ]);
    expect(manifest).toContain("conn-1");
    expect(manifest).toContain("Covan Supabase");
    expect(manifest).toContain("Never guess an id");
  });

  /**
   * covan#251. A workspace whose only connections are Composio apps used to
   * be offered `query_database` and `http_request` because it had "a
   * connection", and the model, shown an app called Supabase, called
   * `query_database` on it six times out of six. A tool is offered for the
   * transports it can use, not for any row.
   */
  it("offers a workspace of connected apps run_tool, and nothing that cannot reach an app", async () => {
    const app = {
      ...CONNECTION,
      id: "conn-app",
      label: "Supabase",
      transport: "composio",
      toolkit_slug: "supabase",
      base_url: "",
    };
    const { tools } = await ask(dbWith([app], []), { ...FULL, COMPOSIO_API_KEY: "ck" } as ToolEnv);
    const names = tools.map((t) => t.name);
    expect(names).toContain("run_tool");
    expect(names).toContain("find_tool");
    expect(names).not.toContain("query_database");
    expect(names).not.toContain("http_request");
    // An app has nothing to describe, and the manifest says so.
    expect(names).not.toContain("describe_connection");
  });

  it("offers an HTTP API http_request, and neither the database nor the app tool", async () => {
    const api = { ...CONNECTION, id: "conn-api", label: "Billing API", transport: "http" };
    const { tools } = await ask(dbWith([api], []), { ...FULL, COMPOSIO_API_KEY: "ck" } as ToolEnv);
    const names = tools.map((t) => t.name);
    expect(names).toContain("http_request");
    expect(names).toContain("describe_connection");
    expect(names).not.toContain("query_database");
    expect(names).not.toContain("run_tool");
  });

  it("offers nothing that needs a connection for one this build does not recognise", async () => {
    const odd = { ...CONNECTION, id: "conn-odd", transport: "unknown" };
    const { tools } = await ask(dbWith([odd], []));
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "list_documents",
      "continue_later",
      "ask_person",
      "remember",
      "covan_guide",
    ]);
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
              or: () => ({
                eq: () => ({ order: async () => ({ data: [CONNECTION], error: null }) }),
              }),
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
    // A question nobody would see is not offered either.
    expect(tools.map((t) => t.name)).not.toContain("ask_person");
    // A note is kept in a conversation, where the person can see it land.
    expect(tools.map((t) => t.name)).not.toContain("remember");
    // What it CAN do is still named, because that is what it is there for.
    expect(tools.map((t) => t.name)).toContain("query_database");
    expect(manifest).toContain("Covan Supabase");
  });

  it("remember is offered in chat and never on a schedule", async () => {
    const chat = await ask(dbWith([], []));
    expect(chat.tools.map((t) => t.name)).toContain("remember");
    const scheduled = await capabilitiesFor({
      db: dbWith([], []),
      env: FULL,
      workspaceId: "ws-1",
      userId: "user-1",
      surface: "schedule",
    });
    expect(scheduled.tools.map((t) => t.name)).not.toContain("remember");
  });

  it("leaves remember out of a request made with an API key", async () => {
    const keyed = await capabilitiesFor({
      db: dbWith([], []),
      env: FULL,
      workspaceId: "ws-1",
      userId: "user-1",
      byApiKey: true,
    });
    expect(keyed.tools.map((t) => t.name)).not.toContain("remember");
    expect(keyed.tools.map((t) => t.name)).toContain("search_documents");
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
    expect(tools.map((t) => t.name)).toEqual([
      "search_documents",
      "list_documents",
      "continue_later",
      "ask_person",
      "remember",
      "covan_guide",
    ]);
  });
});

/**
 * `browse` on a schedule (0100): offered only to a routine whose owner allowed
 * it, because anywhere else it can only refuse — tokens on every run and an
 * invitation to try.
 */
describe("the browser on a schedule", () => {
  const BROWSING = { ...FULL, BROWSER_USE_API_KEY: "bu_test" } as ToolEnv;
  const names = async (input: { surface?: "chat" | "schedule"; browser?: boolean }) =>
    (
      await capabilitiesFor({
        db: dbWith([], []),
        env: BROWSING,
        workspaceId: "ws-1",
        userId: "user-1",
        ...input,
      })
    ).tools.map((t) => t.name);

  it("is left out of a routine that did not allow it", async () => {
    expect(await names({ surface: "schedule" })).not.toContain("browse");
  });

  it("is offered to a routine that did", async () => {
    expect(await names({ surface: "schedule", browser: true })).toContain("browse");
  });

  it("is offered in chat as it always was", async () => {
    expect(await names({})).toContain("browse");
  });
});

/**
 * Starting another routine: offered in chat beside the other sending tools,
 * and on a schedule whatever the channels, because that is where routines
 * hand work to one another.
 */
describe("run_routine", () => {
  const names = async (
    connections: unknown[],
    channels: unknown[],
    surface?: "chat" | "schedule",
  ) =>
    (
      await capabilitiesFor({
        db: dbWith(connections, channels),
        env: FULL,
        workspaceId: "ws-1",
        userId: "user-1",
        ...(surface ? { surface } : {}),
      })
    ).tools.map((t) => t.name);

  it("is offered in chat to somebody with a channel", async () => {
    expect(await names([], [CHANNEL])).toContain("run_routine");
    expect(await names([], [])).not.toContain("run_routine");
  });

  it("is offered on a schedule, where there are never channels", async () => {
    expect(await names([], [], "schedule")).toContain("run_routine");
    expect(await names([], [], "schedule")).not.toContain("watch_event");
  });
});

/**
 * Configuration's Tools switches (0136): stored as what is off, read for the
 * agent the turn is for. The browser goes from the list; a connection goes
 * from the list and from the manifest that names it.
 */
describe("an agent's Tools switches", () => {
  const BROWSING = { ...FULL, BROWSER_USE_API_KEY: "bu_test" } as ToolEnv;
  function dbFor(off: { browser_off?: boolean; connections_off?: string[] } | null) {
    const base = dbWith([CONNECTION], []) as unknown as {
      from: (t: string) => unknown;
    };
    return {
      from: (table: string) =>
        table === "agents"
          ? {
              select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: off, error: null }) }),
              }),
            }
          : base.from(table),
    } as unknown as SupabaseClient;
  }
  const askFor = (db: SupabaseClient) =>
    capabilitiesFor({ db, env: BROWSING, workspaceId: "ws-1", userId: "user-1", agentId: "a-1" });

  it("offers everything to an agent nobody has switched anything off for", async () => {
    const { tools, manifest } = await askFor(dbFor({ browser_off: false, connections_off: [] }));
    expect(tools.map((t) => t.name)).toContain("browse");
    expect(tools.map((t) => t.name)).toContain("query_database");
    expect(manifest).toContain("conn-1");
  });

  it("takes the browser away from an agent told not to use it", async () => {
    const { tools } = await askFor(dbFor({ browser_off: true, connections_off: [] }));
    expect(tools.map((t) => t.name)).not.toContain("browse");
  });

  it("takes a connection out of the list and the manifest", async () => {
    const { tools, manifest } = await askFor(dbFor({ connections_off: ["conn-1"] }));
    expect(tools.map((t) => t.name)).not.toContain("query_database");
    expect(manifest).not.toContain("conn-1");
  });

  it("turns nothing off when the agent cannot be read", async () => {
    const { tools } = await askFor(dbFor(null));
    expect(tools.map((t) => t.name)).toContain("browse");
  });
});
