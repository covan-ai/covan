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
 *    database connected, no `query_database`: the tokens are wasted and the
 *    prompt is inviting the model to invent a connection id. "Anything" is
 *    per transport — a workspace of Composio apps has connections, and none
 *    of them is a database or an HTTP API.
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
  /**
   * Who is watching, which decides whether the sending tools are worth
   * offering — and, because it decides that, whether the read behind them
   * happens at all.
   *
   * `"schedule"` drops both: `schedule_job` asks a person and a tick has
   * nobody to ask, so it can only ever end as a note saying it did not
   * happen; and `send_email` duplicates the delivery the routine is already
   * about to make. Leaving them in would cost a `delivery_channels` read per
   * run for two tools that cannot finish — and on the cron Worker a read is a
   * subrequest, which is the budget `lib/routines/dispatcher.ts` counts.
   */
  surface?: "chat" | "schedule";
  /**
   * Whether a scheduled run may use the browser — its routine's
   * `browser_access` (0100). Ignored in chat, where every call is approved on
   * a card. On a schedule `browse` is left out unless the owner allowed it: a
   * tool that can only refuse is tokens on every run and an invitation to try.
   */
  browser?: boolean;
}): Promise<AgentCapabilities> {
  const scheduled = input.surface === "schedule";

  // Best-effort. A tool the agent cannot see is a worse turn; a turn that
  // fails because a lookup failed is no turn at all.
  // The caller's own connections and the shared ones (0098): on a scheduled
  // run `input.db` is the service role, and the routine's owner is the caller.
  const connections = await listConnections(input.db, input.workspaceId, input.userId).catch(
    (err: unknown) => {
      console.error("could not list tool connections", err);
      return [];
    },
  );
  const channels = scheduled ? [] : await ownChannels(input.db, input.userId);

  const tools = configuredTools(input.env).filter((tool) => {
    if (tool.name === "browse" && scheduled && !input.browser) return false;
    // A document is written for somebody in a conversation, who watches it
    // fill in; a scheduled run files its own output (`routines/filing.ts`).
    if (tool.name === "write_document" && scheduled) return false;
    // Starting another routine: in chat, for somebody who has somewhere for
    // a routine to deliver (anybody with a routine does) — and on a schedule
    // whatever the channels, because routines handing work to one another is
    // what it is for there. It cannot move a routine off the one-call path:
    // `search_documents` is always offered, so a schedule never had no tools.
    if (tool.name === "run_routine") return scheduled || channels.length > 0;
    if (tool.needs === "channel") return channels.length > 0;
    if (tool.needs) {
      const usable = tool.needs.connection;
      return connections.some((c) => usable.includes(c.transport));
    }
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

/**
 * This person's own delivery channels, or none.
 *
 * Best-effort like the connections read above, and for a sharper reason than
 * symmetry: this runs before the chat stream opens, so a throw here is a 500
 * where there would otherwise have been an answer. An agent that cannot list
 * the channels is an agent that cannot offer to send to one, which is a worse
 * turn and still a turn.
 */
async function ownChannels(
  db: SupabaseClient,
  userId: string,
): Promise<Array<{ id: string; kind: string; label: string | null }>> {
  try {
    const { data, error } = await db
      .from("delivery_channels")
      .select("id, kind, label")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; kind: string; label: string | null }>;
  } catch (err) {
    console.error("could not list delivery channels", err);
    return [];
  }
}
