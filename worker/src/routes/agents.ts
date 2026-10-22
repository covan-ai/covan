import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { AGENT_ACCESS, AVATAR_MARKS, mapAgent } from "../lib/dto";
import { callerWorkspaceId } from "../lib/workspace";
import { callDeletionFn } from "../lib/deletion";
import { REASONING_EFFORTS, MODEL_IDS, ENDPOINT_MODEL_PATTERN } from "../lib/models";
import { endpointIsVisible } from "../lib/model-endpoints";

const agents = new Hono<AppEnv>();

// Two things are selected here that a reader would not predict, and they are
// selected for the same reason: `mapAgent` flattens every attached bundle's
// documents into one list, and once flattened a row has no way back to
// anything it was nested under.
//
// `documents.bundle_id`, although `agent_bundles.bundle_id` is already here —
// the Knowledge explorer needs it on every row it renders, because it is what
// the bundle chip says and what a move knows it is moving away from.
//
// `routines(name)`, embedded through `documents.routine_id`, which resolves
// through `routines`' own RLS rather than through the document's: a colleague's
// private routine filing into a shared bundle comes back as a null name beside
// a real id, and that is exactly what the Knowledge tab should say about it.
// See `DocumentDTO.routineName`.
//
// One string literal, not a concatenation. postgrest-js infers the row type
// from the literal, and `"a," + "b"` widens the argument to `string`, which
// turns every field on the result into `GenericStringError`.
//
// `my_access` is a computed field (0104's `my_access(agents)`): the caller's own
// level, answered by the function the policies ask, so the screen and the
// database cannot disagree about what this person may do.
const AGENT_SELECT =
  "*, my_access, agent_shares(user_id, access), agent_bundles(bundle_id, knowledge_bundles(documents(id,name,size,created_at,bundle_id,connection_id,external_url,routine_id,routines(name),document_chunks(count),index_status,index_cursor,index_total,index_error)))";

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

/**
 * `model` is an allowlist for the same reason `reasoningEffort` beside it is:
 * an id this build does not know is not a preference, it is a silent fall to
 * `DEFAULT_MODEL` at every read, which nothing in the product ever says out
 * loud. It followed `routes/workspace.ts:25` two fields late.
 *
 * Narrowed 2026-09-29 after checking what is actually stored: every one of the
 * 55 agents in production holds an id that is in `MODEL_IDS`, so no existing
 * agent is locked out of a PATCH of some other field. Whether this *deployment*
 * can serve the id is a second question and deliberately not asked here —
 * `modelsFor` on the settings screen keeps an agent's current pick in the list
 * even when the key behind it is gone, and `resolveModel` falls it through at
 * read time rather than refusing to answer.
 */
/**
 * Who reaches an agent (0104), always sent whole: `shares` is the complete
 * list, and anybody missing from it loses their share. `workspaceAccess` null
 * means the agent is not shared with the workspace as a whole.
 */
const sharingSchema = z.object({
  workspaceAccess: z.enum(AGENT_ACCESS).nullable(),
  shares: z.array(z.object({ userId: z.string().uuid(), access: z.enum(AGENT_ACCESS) })).max(500),
});

const createAgentSchema = z.object({
  name: z.string().min(1),
  emoji: z.string().optional(),
  // One of the eight marks; absent or null is the monogram.
  avatar: z.enum(AVATAR_MARKS).nullable().optional(),
  model: z.enum(MODEL_IDS).or(z.string().regex(ENDPOINT_MODEL_PATTERN)).optional(),
  persona: z.string().optional(),
  mode: z.enum(["normal", "brainstorm"]).optional(),
  ...tuningFields,
  // Absent is Only me, which is what a new agent is unless somebody says so.
  sharing: sharingSchema.optional(),
});

const updateAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    emoji: z.string().optional(),
    avatar: z.enum(AVATAR_MARKS).nullable().optional(),
    model: z.enum(MODEL_IDS).or(z.string().regex(ENDPOINT_MODEL_PATTERN)).optional(),
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
  if ("avatar" in body) patch.avatar = body.avatar;
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

  const workspaceId = await callerWorkspaceId(c);
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
  // A workspace endpoint (0135) has to be one the caller can see.
  if (parsed.data.model && !(await endpointIsVisible(db, parsed.data.model))) {
    return c.json({ error: "that model endpoint is not in this workspace" }, 400);
  }

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) {
    return c.json({ error: "no workspace found for user" }, 400);
  }

  const {
    name,
    emoji,
    avatar,
    model,
    persona,
    mode,
    temperature,
    reasoningEffort,
    webSearch,
    sharing,
  } = parsed.data;

  const { data, error } = await db
    .from("agents")
    .insert({
      workspace_id: workspaceId,
      name,
      emoji: emoji ?? null,
      avatar: avatar ?? null,
      model: model ?? null,
      persona: persona ?? null,
      mode: mode ?? "normal",
      // Null is the default and means the mode decides, which is what every
      // agent created before 0048 has.
      temperature: temperature ?? null,
      reasoning_effort: reasoningEffort ?? null,
      // Off unless asked for. This was `?? true` from 2026-09-17 (037cd94,
      // "web search should be the default modern experience") until 2026-09-29,
      // and what changed is not the product opinion but a number that did not
      // exist then: Anthropic expands the 51 characters `anthropicParams` sends
      // into **5,588 prompt tokens on every request**, searched or not, at the
      // front of the cacheable prefix — ~36% of a cold turn's cost and ~8% of a
      // warm one, $0.365 across production to date.
      //
      // What made it indefensible rather than merely expensive is that nothing
      // recorded whether a search had ever run: `server_tool_use` was read
      // nowhere, so every agent paying for it was paying on an assumption.
      // `PassUsage.searches` now records it, which is what a future argument
      // for turning this back on would be made of.
      //
      // Note the column default in 0051 is `false`; only this line overrode it.
      // Existing agents are untouched — the column is already written for all
      // of them — and the Settings toggle is unchanged. See covan-ai/covan#228.
      web_search: webSearch ?? false,
      created_by: user.id,
      // Insertable, never updatable: after this, only `set_agent_sharing`.
      workspace_access: sharing?.workspaceAccess ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    return c.json({ error: "failed to create agent" }, 500);
  }

  // The people come second because they are rows of their own, and the agent
  // has to exist before anything can point at it. A list that fails to save
  // leaves the agent shared with nobody named rather than with half of them,
  // and says so.
  if (sharing && sharing.shares.length > 0) {
    const failure = await saveSharing(db, data.id, sharing);
    if (failure) {
      return c.json({ error: `the agent was created, but ${failure.message}` }, failure.status);
    }
  }

  const { data: created, error: readError } = await db
    .from("agents")
    .select(AGENT_SELECT)
    .eq("id", data.id)
    .single();

  if (readError || !created) {
    return c.json({ error: "failed to load agent" }, 500);
  }

  return c.json(mapAgent(created), 201);
});

// PATCH /agents/:id
agents.patch("/agents/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = updateAgentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  // A workspace endpoint (0135) has to be one the caller can see.
  if (parsed.data.model && !(await endpointIsVisible(db, parsed.data.model))) {
    return c.json({ error: "that model endpoint is not in this workspace" }, 400);
  }

  // `.select("id")` so a refusal is visible. RLS answers an update it does not
  // allow by matching no rows, and without the rows this route reported that
  // as success — to somebody who can use the agent but not change it.
  const { data: updated, error: updateError } = await db
    .from("agents")
    .update(agentColumns(parsed.data))
    .eq("id", id)
    .select("id");

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
  if ((updated ?? []).length === 0) {
    return c.json({ error: "you can use this agent but not change it" }, 403);
  }

  return c.json(mapAgent(data));
});

// PUT /agents/:id/sharing
//
// The whole sharing state at once — see `sharingSchema`. Only somebody with
// full access gets past `set_agent_sharing`; everybody else is told so.
agents.put("/agents/:id/sharing", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const parsed = sharingSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const failure = await saveSharing(db, id, parsed.data);
  if (failure) return c.json({ error: failure.message }, failure.status);

  const { data, error } = await db.from("agents").select(AGENT_SELECT).eq("id", id).maybeSingle();
  if (error) {
    return c.json({ error: "failed to load agent" }, 500);
  }
  if (!data) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(mapAgent(data));
});

/**
 * `set_agent_sharing`, and its refusals as HTTP. The SQLSTATE is the contract,
 * as it is for the deletion functions (`lib/deletion.ts`):
 *
 *   42501  not full access              -> 403
 *   P0002  no such agent, or not yours  -> 404
 *   22023  the list itself is wrong     -> 400, with the database's sentence,
 *          which was written for a person ("that person is not a member of
 *          this workspace")
 */
async function saveSharing(
  db: AppEnv["Variables"]["db"],
  agentId: string,
  sharing: z.infer<typeof sharingSchema>,
): Promise<{ status: 400 | 403 | 404 | 500; message: string } | null> {
  const { error } = await db.rpc("set_agent_sharing", {
    p_agent_id: agentId,
    p_workspace_access: sharing.workspaceAccess,
    p_shares: sharing.shares.map((s) => ({ user_id: s.userId, access: s.access })),
  });
  if (!error) return null;

  if (error.code === "42501") {
    return {
      status: 403,
      message: "only people with full access can change who can use this agent",
    };
  }
  if (error.code === "P0002") return { status: 404, message: "not found" };
  if (error.code === "22023") return { status: 400, message: error.message };

  console.error("set_agent_sharing failed", error);
  return { status: 500, message: "failed to save who can use this agent" };
}

// GET /agents/:id/delete-summary
//
// What a delete takes with it, for the sentence in the dialog (A25): "Its 19
// threads stay readable for 30 days under Recently deleted, then go. The 2
// routines pointed at it stop now. The 3 folders it reads are not touched."
// Counts only, and only for somebody who could press the button — the
// function asks the same `manage` question `soft_delete_agent` does.
agents.get("/agents/:id/delete-summary", async (c) => {
  const { data, error } = await c
    .get("db")
    .rpc("agent_delete_summary", { p_agent_id: c.req.param("id") })
    .maybeSingle<{ threads: number; routines: number; folders: number }>();

  if (error) {
    if (error.code === "P0002") return c.json({ error: "not found" }, 404);
    if (error.code === "42501") {
      return c.json({ error: "only people with full access can delete this agent" }, 403);
    }
    console.error("agent_delete_summary failed", error);
    return c.json({ error: "failed to count what the agent holds" }, 500);
  }
  return c.json({
    threads: data?.threads ?? 0,
    routines: data?.routines ?? 0,
    folders: data?.folders ?? 0,
  });
});

// GET /agents/:id/knowledge-usage
//
// For each folder the agent reads, how many of its replies in the window cited
// something in it — "9 files · used in 61 replies this month" (A32). Counted
// by `agent_knowledge_usage` (0124) for anybody who can use the agent.
const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(365).optional() });

agents.get("/agents/:id/knowledge-usage", async (c) => {
  const parsed = usageQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const args = { p_agent_id: c.req.param("id"), p_days: parsed.data.days ?? 30 };
  const db = c.get("db");
  const [usage, grounding] = await Promise.all([
    db.rpc("agent_knowledge_usage", args),
    // "Asked, not covered" (A32, 0134): how its replies were grounded.
    db.rpc("agent_coverage", args),
  ]);
  const error = usage.error ?? grounding.error;
  if (error) {
    if (error.code === "P0002") return c.json({ error: "not found" }, 404);
    console.error("agent knowledge usage failed", error);
    return c.json({ error: "failed to count what the agent read" }, 500);
  }
  const byBundle: Record<string, { replies: number }> = {};
  for (const row of (usage.data ?? []) as Array<{ bundle_id: string; replies: number }>) {
    byBundle[row.bundle_id] = { replies: row.replies ?? 0 };
  }
  const g = ((grounding.data ?? []) as Array<Record<string, number | string>>)[0];
  const answers = Number(g?.answers) || 0;
  const notCovered = (Number(g?.fallback) || 0) + (Number(g?.ungrounded) || 0);
  return c.json({
    byBundle,
    answers,
    // Null with nothing to divide: "0% not covered" of no replies says nothing.
    notCoveredPct: answers > 0 ? Math.round((notCovered / answers) * 100) : null,
  });
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
  if (failure) {
    // Deleting an agent is a full-access decision now (0104), not a
    // workspace-writer one, so the generic sentence would be wrong.
    const message =
      failure.status === 403
        ? "only people with full access can delete this agent"
        : failure.message;
    return c.json({ error: message }, failure.status);
  }

  return c.json({ ok: true });
});

export { agents };
