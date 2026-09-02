import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapAgent } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";
import { callDeletionFn } from "../lib/deletion";

const agents = new Hono<AppEnv>();

const AGENT_SELECT =
  "*, agent_bundles(bundle_id, knowledge_bundles(documents(id,name,size,created_at,document_chunks(count))))";

const createAgentSchema = z.object({
  name: z.string().min(1),
  emoji: z.string().optional(),
  model: z.string().optional(),
  persona: z.string().optional(),
  mode: z.enum(["normal", "brainstorm"]).optional(),
});

const updateAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    emoji: z.string().optional(),
    model: z.string().optional(),
    persona: z.string().optional(),
    mode: z.enum(["normal", "brainstorm"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

// GET /agents
agents.get("/agents", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json([]);
  }

  const { data, error } = await db
    .from("agents")
    .select(AGENT_SELECT)
    .eq("workspace_id", workspaceId)
    .order("created_at");

  if (error) {
    return c.json({ error: "failed to load agents" }, 500);
  }

  return c.json((data ?? []).map(mapAgent));
});

// POST /agents
agents.post("/agents", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = createAgentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user" }, 400);
  }

  const { name, emoji, model, persona, mode } = parsed.data;

  const { data, error } = await db
    .from("agents")
    .insert({
      workspace_id: workspaceId,
      name,
      emoji: emoji ?? null,
      model: model ?? null,
      persona: persona ?? null,
      mode: mode ?? "normal",
      created_by: user.id,
    })
    .select("*")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to create agent" }, 500);
  }

  return c.json(mapAgent({ ...data, agent_bundles: [] }), 201);
});

// PATCH /agents/:id
agents.patch("/agents/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = updateAgentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { error: updateError } = await db.from("agents").update(parsed.data).eq("id", id);

  if (updateError) {
    return c.json({ error: "failed to update agent" }, 500);
  }

  const { data, error } = await db.from("agents").select(AGENT_SELECT).eq("id", id).maybeSingle();

  if (error) {
    return c.json({ error: "failed to load agent" }, 500);
  }
  if (!data) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(mapAgent(data));
});

// DELETE /agents/:id
//
// No longer a delete. `soft_delete_agent` marks the agent and, in the same
// statement, the sessions and routines that hung off it — which the foreign
// keys used to destroy outright, taking every message with them. The sweeper
// finishes the job thirty days later if nobody asks for it back.
//
// The refusal now arrives as a raised exception rather than as a delete that
// matched no rows. That is the improvement: RLS answers an unpermitted delete
// with silence and `{ok:true}`, which is how a viewer used to be told they had
// succeeded at something the database had just refused.
agents.delete("/agents/:id", async (c) => {
  const failure = await callDeletionFn(
    c.get("db"),
    "soft_delete_agent",
    { p_agent_id: c.req.param("id") },
    "failed to delete agent",
  );
  if (failure) return c.json({ error: failure.message }, failure.status);

  return c.json({ ok: true });
});

export { agents };
