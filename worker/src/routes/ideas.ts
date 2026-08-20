import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapIdea } from "../lib/dto";

const ideas = new Hono<AppEnv>();

const stageEnum = z.enum(["review", "promising", "in_progress", "parked"]);

const createIdeaSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  stage: stageEnum.optional(),
  sourceMessageId: z.string().optional(),
});

const updateIdeaSchema = z
  .object({
    title: z.string().min(1).optional(),
    detail: z.string().nullable().optional(),
    stage: stageEnum.optional(),
    position: z.number().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

// GET /sessions/:id/ideas — the board, ordered stage then position.
ideas.get("/sessions/:id/ideas", async (c) => {
  const db = c.get("db");
  const sessionId = c.req.param("id");

  const { data, error } = await db
    .from("ideas")
    .select("*")
    .eq("session_id", sessionId)
    .order("stage", { ascending: true })
    .order("position", { ascending: true });

  if (error) {
    return c.json({ error: "failed to load ideas" }, 500);
  }
  return c.json((data ?? []).map(mapIdea));
});

// POST /sessions/:id/ideas — add a card. workspace_id is copied from the
// session; created_by is the caller (RLS also enforces created_by = auth.uid()).
// position lands at the end of the target stage.
ideas.post("/sessions/:id/ideas", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const sessionId = c.req.param("id");

  const parsed = createIdeaSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { title, detail, stage, sourceMessageId } = parsed.data;
  const targetStage = stage ?? "review";

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("workspace_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) {
    return c.json({ error: "failed to load session" }, 500);
  }
  if (!session || !session.workspace_id) {
    return c.json({ error: "not found" }, 404);
  }

  // End of the target stage: max(position) + 1.
  const { data: last } = await db
    .from("ideas")
    .select("position")
    .eq("session_id", sessionId)
    .eq("stage", targetStage)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = (last?.position ?? 0) + 1;

  const { data, error } = await db
    .from("ideas")
    .insert({
      session_id: sessionId,
      workspace_id: session.workspace_id,
      title,
      detail: detail ?? null,
      stage: targetStage,
      position,
      created_by: user.id,
      source_message_id: sourceMessageId ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to create idea" }, 500);
  }
  return c.json(mapIdea(data), 201);
});

// PATCH /ideas/:id — edit text or move (stage/position). RLS permits any member
// who can read the parent session.
ideas.patch("/ideas/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = updateIdeaSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

  const { data, error } = await db
    .from("ideas")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    return c.json({ error: "failed to update idea" }, 500);
  }
  if (!data) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(mapIdea(data));
});

// DELETE /ideas/:id
ideas.delete("/ideas/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { error } = await db.from("ideas").delete().eq("id", id);
  if (error) {
    return c.json({ error: "failed to delete idea" }, 500);
  }
  return c.json({ ok: true });
});

export { ideas };
