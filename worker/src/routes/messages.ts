import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";

const messages = new Hono<AppEnv>();

const createMessageSchema = z.object({
  sessionId: z.string().min(1),
  role: z.literal("user"),
  content: z.string().min(1),
});

const updateMessageSchema = z.object({
  content: z.string().min(1),
});

// POST /messages
messages.post("/messages", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = createMessageSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { sessionId, role, content } = parsed.data;

  const { data, error } = await db
    .from("messages")
    .insert({
      session_id: sessionId,
      role,
      content,
      sender_id: user.id,
    })
    .select("*")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to create message" }, 500);
  }

  // Bump the parent session's updated_at so session lists sort correctly.
  // Uses the touch_session RPC (SECURITY DEFINER) rather than a direct UPDATE:
  // the owner-only RLS policy would silently no-op the bump when a non-owner
  // posts to a shared session, so the shared chat would never re-sort.
  // Non-fatal: the message is already created, so only log a failure.
  const { error: bumpError } = await db.rpc("touch_session", { p_session_id: sessionId });
  if (bumpError) {
    console.error("failed to bump chat_sessions.updated_at", bumpError);
  }

  return c.json(mapMessage(data), 201);
});

// PATCH /messages/:id
messages.patch("/messages/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = updateMessageSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { data, error } = await db
    .from("messages")
    .update({ content: parsed.data.content })
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    return c.json({ error: "failed to update message" }, 500);
  }
  if (!data) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(mapMessage(data));
});

// DELETE /messages/after/:id
messages.delete("/messages/after/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const id = c.req.param("id");

  const { data: anchor, error: anchorError } = await db
    .from("messages")
    .select("session_id, created_at")
    .eq("id", id)
    .maybeSingle();

  if (anchorError) {
    return c.json({ error: "failed to load message" }, 500);
  }
  if (!anchor) {
    return c.json({ error: "not found" }, 404);
  }

  // Checked here even though `messages_delete_owner` already refuses it,
  // because of *how* it refuses: RLS answers a delete it has no policy for by
  // matching no rows and reporting no error. So a member of a shared session
  // who pressed Regenerate got `{ ok: true }`, nothing deleted, and then a
  // stream that failed with "no user message to respond to" — the reply they
  // were trying to replace still sitting at the end of the conversation. An
  // honest 403 is what the interface can act on.
  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("user_id")
    .eq("id", anchor.session_id)
    .maybeSingle();

  if (sessionError) {
    return c.json({ error: "failed to load session" }, 500);
  }
  if (!session) {
    return c.json({ error: "not found" }, 404);
  }
  if (session.user_id !== user.id) {
    return c.json({ error: "only the owner of a conversation can rewrite it" }, 403);
  }

  const { error } = await db
    .from("messages")
    .delete()
    .eq("session_id", anchor.session_id)
    .gt("created_at", anchor.created_at);

  if (error) {
    return c.json({ error: "failed to delete messages" }, 500);
  }

  return c.json({ ok: true });
});

// POST /messages/:id/show
//
// Put a different version of an answer back on screen. Regenerating keeps the
// reply it replaced (0050), and this is how somebody goes back to it.
messages.post("/messages/:id/show", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const id = c.req.param("id");

  // Read through the caller's own client, so a message they cannot see is a
  // 404 rather than a version switch on somebody else's conversation.
  const { data: target, error: targetError } = await db
    .from("messages")
    .select("id, session_id, role")
    .eq("id", id)
    .maybeSingle();

  if (targetError) {
    return c.json({ error: "failed to load message" }, 500);
  }
  if (!target) {
    return c.json({ error: "not found" }, 404);
  }
  if (target.role !== "assistant") {
    return c.json({ error: "only a reply has versions" }, 400);
  }

  // The same check, and for the same reason, as DELETE /messages/after/:id
  // above: `show_message_version` is SECURITY DEFINER and answers a caller who
  // does not own the conversation by matching nothing and reporting success.
  // An honest 403 is what the interface can act on.
  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("user_id")
    .eq("id", target.session_id)
    .maybeSingle();

  if (sessionError) {
    return c.json({ error: "failed to load session" }, 500);
  }
  if (!session) {
    return c.json({ error: "not found" }, 404);
  }
  if (session.user_id !== user.id) {
    return c.json({ error: "only the owner of a conversation can rewrite it" }, 403);
  }

  // One statement inside the function, because the two-statement version has a
  // window in which the conversation has no answer in it. See 0050.
  const { error } = await db.rpc("show_message_version", { p_message_id: id });
  if (error) {
    return c.json({ error: "failed to switch version" }, 500);
  }

  return c.json({ ok: true });
});

export { messages };
