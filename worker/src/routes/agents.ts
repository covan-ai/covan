import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapAgent } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";
import { callDeletionFn } from "../lib/deletion";
import { REASONING_EFFORTS } from "../lib/models";

const agents = new Hono<AppEnv>();

// `routines(name)` is embedded through `documents.routine_id`, and it resolves
// through `routines`' own RLS rather than through the document's: a colleague's
// private routine filing into a shared bundle comes back as a null name beside
// a real id, which is exactly what the Knowledge tab should say about it. See
// `DocumentDTO.routineName`.
const AGENT_SELECT =
  "*, agent_bundles(bundle_id, knowledge_bundles(documents(id,name,size,created_at,routine_id,routines(name),document_chunks(count))))";

/**
 * The two tuning settings, on both schemas.
 *
 * Nullable as well as optional, and the difference is the whole feature:
 * *absent* means "do not change this", *null* means "put it back on Auto". A
 * field that could only be absent or a number would let somebody set a
 * temperature and never unset one.
 *
 * The bounds are the same as migration 0048's check constraint, stated twice on
 * purpose — the database is what guarantees it, and this is what turns a
 * violation into a 400 naming the field instead of a 500 naming a constraint.
 */
const tuningFields = {
  temperature: z.number().min(0).max(2).nullable().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
  webSearch: z.boolean().optional(),
};

const createAgentSchema = z.object({
  name: z.string().min(1),
  emoji: z.string().optional(),
  model: z.string().optional(),
  persona: z.string().optional(),
  mode: z.enum(["normal", "brainstorm"]).optional(),
  ...tuningFields,
});

const updateAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    emoji: z.string().optional(),
    model: z.string().optional(),
    persona: z.string().optional(),
    mode: z.enum(["normal", "brainstorm"]).optional(),
    ...tuningFields,
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

/**
 * The validated body as database columns.
 *
 * This route used to hand `parsed.data` straight to `.update()`, which worked
 * only because every field it accepted happened to be spelled the same way in
 * both places. `reasoningEffort` is the first one that is not, and the failure
 * that would have caused is not a type error — it is PostgREST refusing a
 * column named `reasoningEffort` at runtime, on the one request the user
 * actually cares about. `routes/workspace.ts` has mapped `defaultModel` by hand
 * for the same reason since 0014.
 *
 * Only keys that were sent are copied, so "absent" stays absent and a PATCH of
 * one field remains a PATCH of one field.
 */
function agentColumns(body: z.infer<typeof updateAgentSchema>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ("name" in body) patch.name = body.name;
  if ("emoji" in body) patch.emoji = body.emoji;
  if ("model" in body) patch.model = body.model;
  if ("persona" in body) patch.persona = body.persona;
  if ("mode" in body) patch.mode = body.mode;
  if ("temperature" in body) patch.temperature = body.temperature;
  if ("reasoningEffort" in body) patch.reasoning_effort = body.reasoningEffort;
  if ("webSearch" in body) patch.web_search = body.webSearch;
  return patch;
}

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

  const { name, emoji, model, persona, mode, temperature, reasoningEffort, webSearch } =
    parsed.data;

  const { data, error } = await db
    .from("agents")
    .insert({
      workspace_id: workspaceId,
      name,
      emoji: emoji ?? null,
      model: model ?? null,
      persona: persona ?? null,
      mode: mode ?? "normal",
      // Null is the default and means the mode decides, which is what every
      // agent created before 0048 has.
      temperature: temperature ?? null,
      reasoning_effort: reasoningEffort ?? null,
      // Web search is on by default. Models that support it (Opus 5/4.8/4.7/4.6,
      // Sonnet 5/4.6) get web_search_20260209; the toggle remains for edge cases
      // where the team explicitly wants answers limited to their documents only.
      web_search: webSearch ?? true,
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

  const { error: updateError } = await db
    .from("agents")
    .update(agentColumns(parsed.data))
    .eq("id", id);

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
