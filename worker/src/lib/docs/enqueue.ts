import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings } from "../../types";
import { serviceClient } from "../supabase";
import { retrieveForAgent } from "../retrieval";
import {
  selectHistory,
  MSG_HISTORY_LIMIT,
  HISTORY_CHAR_BUDGET,
  PER_MESSAGE_CHAR_CAP,
  type HistoryTurn,
} from "../history";
import { ensureReportBundle } from "./bundle";
import { kickDocumentJob } from "./host";
import { mapDocumentJob, JOB_COLUMNS, type DocumentJobDto } from "./dto";

/**
 * Asking for a document: the one way in, for the agent's tool and the Report
 * button alike.
 *
 * Everything that needs the caller is done here, with the caller's own client,
 * while the caller is still here: the bundle is found or made (which is the
 * permission check — a viewer cannot), the conversation is read (which is the
 * other one — RLS shows only a conversation the caller may see), and the
 * passages are retrieved. The job row is then written with the service role,
 * because no client role may write one (0102), scoped to the workspace those
 * reads established. After this the engine never needs the caller's token,
 * which matters: a twelve-part document can outlive it.
 */

export type EnqueueInput = {
  /** The caller's own client. Every read and permission check goes through it. */
  db: SupabaseClient;
  env: Bindings;
  workspaceId: string;
  agent: { id: string; name: string };
  userId: string;
  sessionId: string | null;
  instruction: string;
  /** A working title; the outline call may improve on it. */
  title: string;
  /** A bundle the caller chose. Unset means the agent's reports bundle. */
  bundleId?: string;
  origin: "tool" | "button";
};

export type EnqueueResult =
  | { ok: true; job: DocumentJobDto; embeddingTokens: number }
  | { ok: false; status: 403 | 404 | 500; reason: string };

export async function enqueueDocumentJob(input: EnqueueInput): Promise<EnqueueResult> {
  const { db, env } = input;

  let bundleId = input.bundleId;
  if (bundleId) {
    // Asked of the caller's client, scoped to the workspace: a bundle they
    // cannot see, or one somewhere else, is one they may not file into.
    const { data, error } = await db
      .from("knowledge_bundles")
      .select("id")
      .eq("id", bundleId)
      .eq("workspace_id", input.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return { ok: false, status: 500, reason: "failed to load bundle" };
    if (!data) return { ok: false, status: 404, reason: "not found" };
  } else {
    const ensured = await ensureReportBundle(db, {
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
      agentName: input.agent.name,
      userId: input.userId,
    });
    if (!ensured.ok) return { ok: false, status: 403, reason: ensured.reason };
    bundleId = ensured.bundleId;
  }

  let turns: HistoryTurn[] = [];
  if (input.sessionId) {
    const { data: recent, error } = await db
      .from("messages")
      .select("role, content")
      .eq("session_id", input.sessionId)
      .order("created_at", { ascending: false })
      .limit(MSG_HISTORY_LIMIT);
    if (error) return { ok: false, status: 500, reason: "failed to load messages" };
    turns = (recent ?? [])
      .slice()
      .reverse()
      .map((m: { role: string; content: string }) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      }));
  }

  // The instruction is the question retrieval answers, not the last thing
  // said: "write this up for the board" is what the document is about, and the
  // history is only there to say what "this" refers to.
  const { ragBlock, embeddingTokens } = await retrieveForAgent(
    db,
    env,
    input.agent.id,
    input.instruction,
    turns,
  );

  const history = selectHistory(turns, {
    maxChars: HISTORY_CHAR_BUDGET,
    perMessageCap: PER_MESSAGE_CHAR_CAP,
  });

  const service = serviceClient(env);
  const { data, error: insertError } = await service
    .from("document_jobs")
    .insert({
      workspace_id: input.workspaceId,
      bundle_id: bundleId,
      agent_id: input.agent.id,
      session_id: input.sessionId,
      requested_by: input.userId,
      origin: input.origin,
      instruction: input.instruction,
      title: input.title,
      history,
      sources: ragBlock,
    })
    .select(JOB_COLUMNS)
    .single();
  const job = data as unknown as Record<string, unknown> | null;
  if (insertError || !job) {
    console.error("failed to create a document job", insertError);
    return { ok: false, status: 500, reason: "failed to start the document" };
  }

  await kickDocumentJob(env, job.id as string);

  return { ok: true, job: mapDocumentJob(job, []), embeddingTokens };
}
