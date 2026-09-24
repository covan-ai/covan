import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompletionMessage, ToolCall } from "../completion";
import type { AgentStep, PausedTurn } from "./loop";
import { MAX_STEP_EXCERPT_CHARS, cap } from "./budget";

/**
 * The bookkeeping either end of a turn: writing down what it did, and parking
 * it when it has to wait for a person.
 *
 * Split out of `routes/chat.ts` because two routes need it — the one that
 * starts a turn and the one that finishes a paused one — and a second copy of
 * "how a step is written" is a second place for the two halves of one reply to
 * disagree about what happened.
 *
 * Everything here takes the service-role client. `message_steps` and
 * `paused_turns` have no write policy for any client role at all (0060), on
 * purpose: they are the worker's account of its own behaviour, and an account
 * the subject can edit is not an account.
 */

/** A paused turn, read back in the shape the resume needs it. */
export type StoredPause = {
  id: string;
  sessionId: string;
  messageId: string | null;
  workspaceId: string;
  agentId: string;
  userId: string;
  tool: string;
  toolCall: ToolCall;
  summary: string;
  proposal: unknown;
  messages: CompletionMessage[];
  steps: AgentStep[];
  model: string | null;
  status: string;
  expiresAt: string;
};

/**
 * Write the steps of one reply.
 *
 * An upsert rather than an insert, and that is what makes a resumed turn
 * simple: the pause already wrote step N as `pending`, and the resume writes
 * the same index again with the status it ended up having. One statement, no
 * branch on whether this is the first half of the turn or the second.
 */
export async function writeSteps(
  service: SupabaseClient,
  messageId: string,
  steps: AgentStep[],
): Promise<void> {
  if (steps.length === 0) return;
  const { error } = await service.from("message_steps").upsert(
    steps.map((step) => ({
      message_id: messageId,
      step_index: step.index,
      tool: step.tool,
      request: step.request ?? {},
      result_excerpt: cap(step.resultExcerpt ?? "", MAX_STEP_EXCERPT_CHARS),
      // The two halves of the same fact: `result_excerpt` is what a person
      // reads, trimmed to 2,000 characters, and `result_chars` is how much the
      // model was actually given, up to 8,000. Recording only the first made
      // every large result look identical from the outside, which is why the
      // tool-output budget could not be tuned against anything.
      //
      // `?? null` rather than omitted: a pending step has no answer yet and a
      // resumed turn upserts over this row, so the column has to be cleared
      // rather than left holding a number from the wrong half of the turn.
      result_chars: step.resultChars ?? null,
      pass_index: step.pass ?? null,
      status: step.status,
      duration_ms: step.durationMs,
    })),
    { onConflict: "message_id,step_index" },
  );
  // Logged and swallowed. A reply that arrived is worth more than its
  // audit trail, and failing the stream to record a step would be the tail
  // wagging the dog.
  if (error) console.error("failed to write message steps", error);
}

/**
 * Park a turn that is waiting on somebody.
 *
 * `messages` is the whole prompt so far, including the assistant turn that
 * asked for the tool, so the second half of the turn sees exactly what the
 * first half did. That is why the column is withheld from every client role:
 * a client that could write it could rewrite what the model is about to read.
 */
export async function savePausedTurn(
  service: SupabaseClient,
  input: {
    sessionId: string;
    messageId: string | null;
    workspaceId: string;
    agentId: string;
    userId: string;
    model: string;
    paused: PausedTurn;
    steps: AgentStep[];
  },
): Promise<string | null> {
  if (!input.paused.call) return null;
  const { data, error } = await service
    .from("paused_turns")
    .insert({
      session_id: input.sessionId,
      message_id: input.messageId,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      tool: input.paused.call.name,
      tool_call: input.paused.call,
      summary: input.paused.summary ?? "",
      proposal: input.paused.proposal ?? null,
      messages: input.paused.messages,
      steps: input.steps,
      model: input.model,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("failed to park the paused turn", error);
    return null;
  }
  return String(data.id);
}

/**
 * The parked turn, if it is still answerable.
 *
 * Expiry is checked here rather than swept on a schedule: a row that has aged
 * out is refused the moment somebody tries to answer it, which is the only
 * moment it matters. The sweep would be tidiness, and `purge.ts` is where it
 * belongs if it ever earns its place.
 */
export async function loadPausedTurn(
  service: SupabaseClient,
  id: string,
): Promise<{ pause: StoredPause } | { error: string; status: 404 | 409 | 410 }> {
  const { data, error } = await service.from("paused_turns").select("*").eq("id", id).maybeSingle();
  if (error) return { error: "failed to load that confirmation", status: 404 };
  if (!data) return { error: "not found", status: 404 };
  if (data.status !== "pending") {
    return { error: `this was already ${String(data.status)}`, status: 409 };
  }
  if (new Date(String(data.expires_at)).getTime() < Date.now()) {
    return { error: "this confirmation has expired — ask again", status: 410 };
  }
  return {
    pause: {
      id: String(data.id),
      sessionId: String(data.session_id),
      messageId: data.message_id ? String(data.message_id) : null,
      workspaceId: String(data.workspace_id),
      agentId: String(data.agent_id),
      userId: String(data.user_id),
      tool: String(data.tool),
      toolCall: data.tool_call as ToolCall,
      summary: String(data.summary ?? ""),
      proposal: data.proposal,
      messages: (data.messages ?? []) as CompletionMessage[],
      steps: (data.steps ?? []) as AgentStep[],
      model: data.model ? String(data.model) : null,
      status: String(data.status),
      expiresAt: String(data.expires_at),
    },
  };
}

/**
 * Close a parked turn, and say whether this caller was the one who closed it.
 *
 * The `status = 'pending'` filter is what makes two clicks on the same button
 * safe: the second matches no row, gets `false` back, and is refused before
 * the tool runs. Without it, a double-click sends the email twice — and a
 * confirmation is exactly the kind of button people press twice.
 */
export async function resolvePausedTurn(
  service: SupabaseClient,
  id: string,
  status: "approved" | "declined" | "expired",
): Promise<boolean> {
  const { data, error } = await service
    .from("paused_turns")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) {
    console.error("failed to resolve the paused turn", error);
    return false;
  }
  return (data ?? []).length > 0;
}
