import type { ToolContext } from "./registry";

/**
 * Whether this agent may change things in this connection without asking.
 *
 * The second of the three rules (0140): a row in `tool_connection_grants` for
 * the agent and the connection means somebody said "don't ask again" for that
 * app; no row means it asks, and on a schedule it changes nothing there. Reads
 * never come here.
 *
 * Through the caller's own client in a conversation and the engine's on a
 * schedule. Both may read: 0140 grants `select` to `authenticated` and to
 * `service_role`, and the composite foreign keys (0063) are what make a
 * cross-workspace row impossible rather than merely disallowed, which matters
 * because the scheduled read has no caller for RLS to resolve.
 */
export async function mayChangeWithoutAsking(
  ctx: ToolContext,
  connectionId: string,
): Promise<boolean> {
  const { data, error } = await ctx.db
    .from("tool_connection_grants")
    .select("agent_id")
    .eq("agent_id", ctx.agentId)
    .eq("tool_connection_id", connectionId)
    .maybeSingle();
  // A permission that cannot be read is not a permission. Failing closed here
  // costs a question; failing open would let a database hiccup remove it.
  if (error) return false;
  return data !== null && data !== undefined;
}
