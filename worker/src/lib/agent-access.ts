import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_ACCESS, type AgentAccess } from "./dto";

/**
 * What a person may do with an agent, asked on their behalf (0104).
 *
 * For the paths that hold the service role and act for somebody — a routine
 * running for its owner, a Slack question asked by a member — and are
 * therefore filtered by no policy at all. They ask the same function the
 * policies are built on, `agent_access_for`, which only the service role can
 * call, so the answer here is the answer the chat screen would have got.
 *
 * Null means no access. A lookup that fails throws: the callers each have a
 * different sentence for "could not check", and none of them should guess.
 */
export async function agentAccessFor(
  db: SupabaseClient,
  agentId: string,
  userId: string,
): Promise<AgentAccess | null> {
  const { data, error } = await db.rpc("agent_access_for", {
    p_agent_id: agentId,
    p_user_id: userId,
  });
  if (error) throw new Error(`agent access lookup failed: ${error.message}`);
  return typeof data === "string" && (AGENT_ACCESS as readonly string[]).includes(data)
    ? (data as AgentAccess)
    : null;
}
