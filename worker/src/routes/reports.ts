import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { canFileDocuments } from "../types";
import { guardCredits, recordCredits } from "../lib/entitlements/guard";
import { embeddingSpend, spends } from "../lib/entitlements";
import { embeddingModel } from "../lib/embeddings";
import { enqueueDocumentJob } from "../lib/docs/enqueue";

/**
 * The Report button, on the document engine.
 *
 * This route used to write the whole report in one non-streamed model call —
 * 8,192 output tokens, two or three minutes with nothing on screen, and
 * nothing at all if the request died (covan-ai/covan-cloud#331). It now only
 * asks: the job is created, the engine writes it section by section in the
 * background (`lib/docs/engine.ts`), and the answer is a 202 with the job the
 * conversation then shows filling in. The agent's `write_document` tool asks
 * the same way, through the same function.
 */

const reports = new Hono<AppEnv>();

const reportSchema = z.object({
  // What the report should be. Capped for the same reason a chat message is:
  // this rides in every section's prompt.
  instruction: z.string().trim().min(1).max(2000),
  // Unset means the agent's reports bundle, found or made on the server.
  bundleId: z.string().min(1).optional(),
});

/** A working title from the instruction; the outline call names it properly. */
export function workingTitle(instruction: string): string {
  const line = instruction.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// POST /sessions/:id/report — start writing the conversation up as a document.
reports.post("/sessions/:id/report", async (c) => {
  const db = c.get("db");

  const parsed = reportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { instruction, bundleId } = parsed.data;

  if (!canFileDocuments(c.env)) {
    return c.json({ error: "this deployment has no document storage" }, 501);
  }

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("id, workspace_id, agent_id")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (sessionError) return c.json({ error: "failed to load session" }, 500);
  if (!session) return c.json({ error: "not found" }, 404);

  // Before anything is retrieved or written. The session's workspace pays.
  const denied = await guardCredits(c, session.workspace_id as string);
  if (denied) return denied;

  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("id, name")
    .eq("id", session.agent_id)
    .maybeSingle();
  if (agentError) return c.json({ error: "failed to load agent" }, 500);
  if (!agent) return c.json({ error: "not found" }, 404);

  const started = await enqueueDocumentJob({
    db,
    env: c.env,
    workspaceId: session.workspace_id as string,
    agent: { id: agent.id as string, name: agent.name as string },
    userId: c.get("user").id,
    sessionId: session.id as string,
    instruction,
    title: workingTitle(instruction),
    bundleId,
    origin: "button",
  });
  if (!started.ok) return c.json({ error: started.reason }, started.status);

  await recordCredits(
    c,
    spends(embeddingSpend(embeddingModel(c.env), started.embeddingTokens, "retrieval")),
    { sessionId: session.id as string },
  );

  return c.json(started.job, 202);
});

export { reports };
