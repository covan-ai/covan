import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapChatSession, mapMessage } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";

const sessions = new Hono<AppEnv>();

const createSessionSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["chat", "brainstorm"]).optional(),
});

// How long a name a person may type. Deliberately wider than the ~60 characters
// a generated title aims for: that cap exists so the model writes a label
// rather than a sentence, and it has no business limiting someone who knows
// what they want their own conversation called. The sidebar truncates either
// way.
const TITLE_INPUT_MAX_CHARS = 120;

// Both fields optional, at least one required. A PATCH that named both columns
// unconditionally would blank the title of every session somebody shared.
const updateSessionSchema = z
  .object({
    visibility: z.enum(["private", "shared"]).optional(),
    title: z.string().trim().min(1).max(TITLE_INPUT_MAX_CHARS).optional(),
  })
  .refine((v) => v.visibility !== undefined || v.title !== undefined, {
    message: "nothing to update",
  });

// GET /sessions
sessions.get("/sessions", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json([]);
  }

  const { data, error } = await db
    .from("chat_sessions")
    .select("*, messages(count)")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });

  if (error) {
    return c.json({ error: "failed to load sessions" }, 500);
  }

  return c.json((data ?? []).map((row) => mapChatSession(row, [])));
});

// POST /sessions
sessions.post("/sessions", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { agentId, title, kind } = parsed.data;

  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("workspace_id")
    .eq("id", agentId)
    .maybeSingle();
  if (agentError) {
    return c.json({ error: "failed to load agent" }, 500);
  }
  if (!agent) {
    return c.json({ error: "not found" }, 404);
  }

  const { data, error } = await db
    .from("chat_sessions")
    .insert({
      agent_id: agentId,
      user_id: user.id,
      title: title ?? null,
      workspace_id: agent.workspace_id,
      kind: kind ?? "chat",
      visibility: kind === "brainstorm" ? "shared" : "private",
    })
    .select("*")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to create session" }, 500);
  }

  return c.json(mapChatSession(data, []), 201);
});

// PATCH /sessions/:id
sessions.patch("/sessions/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = updateSessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { visibility, title } = parsed.data;

  // RLS restricts UPDATE to the session owner — so on a shared session, only
  // the person who started it can rename it, the same rule that already
  // governs sharing it in the first place.
  const { data, error } = await db
    .from("chat_sessions")
    .update({
      ...(visibility !== undefined ? { visibility } : {}),
      ...(title !== undefined ? { title } : {}),
    })
    .eq("id", id)
    .select("*, messages(count)")
    .maybeSingle();

  if (error) {
    return c.json({ error: "failed to update session" }, 500);
  }
  if (!data) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(mapChatSession(data, []));
});

// DELETE /sessions/:id
sessions.delete("/sessions/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { error } = await db.from("chat_sessions").delete().eq("id", id);

  if (error) {
    return c.json({ error: "failed to delete session" }, 500);
  }

  return c.json({ ok: true });
});

// GET /sessions/:id/messages
//
// Filtered on the session id alone, and that is the whole of it: what a caller
// may read is `messages_select_session_visible`, which since 0031 defers to
// `session_is_visible` — membership of the session's workspace first, then owner
// or shared. Adding a workspace scope here would be a second query guarding
// something the database already refuses, and it is the policy people would go
// on trusting anyway. It was not always so: the same route with the same
// filter handed an ex-member their old transcripts until 0031 closed the owner
// branch above it.
sessions.get("/sessions/:id/messages", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data, error } = await db
    .from("messages")
    .select("*, sender:profiles(id,name,avatar_url)")
    .eq("session_id", id)
    .order("created_at");

  if (error) {
    return c.json({ error: "failed to load messages" }, 500);
  }

  return c.json((data ?? []).map(mapMessage));
});

export { sessions };
