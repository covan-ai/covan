import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One run as a thread in the Inbox (0123, reversing 0070 per routine): the
 * conversation, its one reply, and the pruning that keeps a routine's list of
 * them short.
 *
 * Its own file because two things finish a run. The executor does, for a run
 * that delivered or failed in the tick that started it (`writeRunThread`,
 * which decides what the reply says); and `held.ts` does, for a report that
 * waited on its browser or on a person and was sent later. The second never
 * wrote a thread at all, so a routine that used the browser delivered its
 * report and left nothing in the Inbox.
 *
 * Best-effort: the run is already done and delivered, and a thread that
 * cannot be written must not fail it. Old run threads are pruned to the
 * newest `RUN_THREADS_KEPT`, never one somebody has replied in.
 */

/** How many run threads a routine keeps; older ones nobody replied in go. */
export const RUN_THREADS_KEPT = 20;

export type RunThreadRoutine = {
  id: string;
  agent_id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  visibility?: string | null;
  /** Absent reads as on, the column's default (0123). */
  deliver_inbox?: boolean | null;
};

/**
 * Open the run's thread and write its reply. Null when the routine does not
 * deliver to the Inbox, or the thread could not be written. A test's thread
 * is written either way: it is the only place a test's result goes.
 */
export async function openRunThread(
  db: SupabaseClient,
  routine: RunThreadRoutine,
  reply: {
    content: string;
    finishedAt: Date;
    test?: boolean;
    model?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    cachedTokens?: number | null;
  },
): Promise<string | null> {
  const test = reply.test === true;
  if (routine.deliver_inbox === false && !test) return null;
  try {
    const { data: session, error: sessionError } = await db
      .from("chat_sessions")
      .insert({
        agent_id: routine.agent_id,
        user_id: routine.user_id,
        workspace_id: routine.workspace_id,
        kind: "routine",
        routine_id: routine.id,
        visibility: !test && routine.visibility === "shared" ? "shared" : "private",
        title: test ? `${routine.name} · test` : routine.name,
      })
      .select("id")
      .single();
    if (sessionError || !session) {
      console.error("routine: could not open the run's thread", sessionError);
      return null;
    }
    const sessionId = session.id as string;

    const { error: messageError } = await db.from("messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: reply.content,
      sender_id: null,
      created_at: reply.finishedAt.toISOString(),
      model: reply.model ?? null,
      prompt_tokens: reply.promptTokens ?? null,
      completion_tokens: reply.completionTokens ?? null,
      cached_tokens: reply.cachedTokens ?? null,
      outcome: "answered",
    });
    if (messageError) console.error("routine: could not write the run's reply", messageError);

    await pruneRunThreads(db, routine.id);
    return sessionId;
  } catch (err) {
    console.error("routine: could not write the run's thread", err);
    return null;
  }
}

async function pruneRunThreads(db: SupabaseClient, routineId: string): Promise<void> {
  const { data, error } = await db
    .from("chat_sessions")
    .select("id")
    .eq("routine_id", routineId)
    .eq("kind", "routine")
    .order("created_at", { ascending: false })
    .range(RUN_THREADS_KEPT, RUN_THREADS_KEPT + 49);
  if (error || !data || data.length === 0) return;
  const old = data.map((r) => r.id as string);
  // Kept: any thread somebody wrote in, which is a conversation now.
  const { data: replied } = await db
    .from("messages")
    .select("session_id")
    .in("session_id", old)
    .eq("role", "user");
  const keep = new Set((replied ?? []).map((r) => r.session_id as string));
  const gone = old.filter((id) => !keep.has(id));
  if (gone.length === 0) return;
  const { error: deleteError } = await db.from("chat_sessions").delete().in("id", gone);
  if (deleteError) console.error("routine: could not prune old run threads", deleteError);
}
