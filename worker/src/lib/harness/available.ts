import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredTools, type AgentTool, type ToolEnv } from "./registry";
import { connectionsManifest, listConnections } from "./connections";

/**
 * What this agent, in this workspace, for this person, can actually do — and
 * the paragraph that tells it so.
 *
 * Both surfaces that run a turn ask this one question, which is the point: an
 * agent that can query a database in chat and cannot on a schedule would be a
 * difference nobody could debug, and it would arrive the first time one of the
 * two forgot a filter.
 *
 * Three filters, and they answer three different questions:
 *
 *  - `isConfigured` — can this DEPLOYMENT run the tool. No Resend key, no
 *    `send_email`.
 *  - `needs` — does this WORKSPACE have anything for it to point at. No
 *    connected services, no `query_database`: the tokens are wasted and the
 *    prompt is inviting the model to invent a connection id.
 *  - RLS — may this CALLER see what it points at. Not applied here at all;
 *    the reads below go through the caller's own client, so a connection in
 *    another workspace is already not in the list.
 */

export type AgentCapabilities = {
  tools: AgentTool[];
  /**
   * The lines appended to the cacheable system prefix naming what is
   * reachable. Empty when nothing is — an agent with no connections and no
   * channels gets exactly the prompt it got before tools existed.
   */
  manifest: string;
};

export async function capabilitiesFor(input: {
  db: SupabaseClient;
  env: ToolEnv;
  workspaceId: string;
  userId: string;
}): Promise<AgentCapabilities> {
  // Best-effort, both of them. A tool the agent cannot see is a worse turn;
  // a turn that fails because a lookup failed is no turn at all.
  const connections = await listConnections(input.db, input.workspaceId).catch((err: unknown) => {
    console.error("could not list tool connections", err);
    return [];
  });
  const { data: channelRows } = await input.db
    .from("delivery_channels")
    .select("id, kind, label")
    .eq("user_id", input.userId);
  const channels = channelRows ?? [];

  const tools = configuredTools(input.env).filter((tool) => {
    if (tool.needs === "connection") return connections.length > 0;
    if (tool.needs === "channel") return channels.length > 0;
    return true;
  });

  const parts = [connectionsManifest(connections)];
  if (channels.length > 0) {
    parts.push(
      "Delivery channels you can send to, all belonging to the person you are talking to:\n" +
        channels
          .map((c) => `- ${String(c.label ?? c.kind)} (id: ${String(c.id)}, ${String(c.kind)})`)
          .join("\n") +
        "\nYou cannot send to an address, only to one of these.",
    );
  }

  return { tools, manifest: parts.filter(Boolean).join("\n\n") };
}
