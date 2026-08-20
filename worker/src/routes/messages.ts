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

export { messages };
