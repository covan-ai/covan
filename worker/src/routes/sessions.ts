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
/**
 * The transcript page size: what a client gets by default, and the most it may
 * ask for.
 *
 * Not the same number as `MSG_HISTORY_LIMIT` in `routes/chat.ts`, and
 * deliberately not sharing one with it. That one bounds what the *model* is
 * shown and is sized against a token budget; this one bounds what a *person*
 * is shown and is sized against a scroll. They move for different reasons.
 */
const MESSAGE_PAGE_DEFAULT = 100;
const MESSAGE_PAGE_MAX = 500;

sessions.get("/sessions/:id/messages", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  // How many turns a client gets if it asks for no particular number. Well
  // inside anything a conversation view renders at once, and well inside
  // PostgREST's own ceiling, which is the reason this parameter exists at all.
  const parsed = z
    .object({ limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).optional() })
    .safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const limit = parsed.data.limit ?? MESSAGE_PAGE_DEFAULT;

  // Newest first on the way out of the database, oldest first on the way to
  // the client — and that inversion is the whole point of this query.
  //
  // It used to be a bare ascending `order` with no limit, which meant the
  // limit was PostgREST's (1000 by default on Supabase) and it cut from the
  // far end: a conversation past that many turns returned its first thousand
  // messages and silently dropped everything after them. Not an error, not a
  // truncation anybody could see — the transcript simply stopped, months ago,
  // and kept accepting new messages that never appeared. Taking the newest
  // rows and reversing them makes the part that gets dropped the old part,
  // which is the only end anyone can stand to lose.
  //
  // `id` as a tiebreaker because `created_at` is not unique — two messages
  // written in the same millisecond would otherwise come back in whatever
  // order the planner felt like, and a client asking for the next page would
  // see one of them twice and the other never.
  const { data, error } = await db
    .from("messages")
    .select("*, sender:profiles(id,name,avatar_url), prompt_tokens, completion_tokens, cached_tokens")
    .eq("session_id", id)
    // Superseded replies are earlier takes on an answer that is already here.
    // They belong to the version picker, not to the transcript — somebody
    // scrolling back should see the conversation they had, not every draft of
    // it. 0050's partial index is on exactly this predicate.
    .is("superseded_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    return c.json({ error: "failed to load messages" }, 500);
  }

  const visible = (data ?? []).slice().reverse();

  // Which answers have more than one version, in one query rather than one
  // per answer.
  //
  // Every version but the first carries `original_message_id`, so this row set
  // *is* the grouping: a root with nothing pointing at it has never been
  // regenerated. The root's own id comes from the pointer rather than from a
  // second read, and it is always the earliest version, so prepending it is
  // the whole of the ordering.
  //
  // A session where nothing has been regenerated pays for one empty indexed
  // result, which is almost all of them.
  const { data: alternates, error: alternatesError } = await db
    .from("messages")
    .select("id, original_message_id, created_at")
    .eq("session_id", id)
    .not("original_message_id", "is", null)
    .order("created_at");

  if (alternatesError) {
    return c.json({ error: "failed to load messages" }, 500);
  }

  const chains = new Map<string, string[]>();
  for (const row of (alternates ?? []) as Array<{ id: string; original_message_id: string }>) {
    const chain = chains.get(row.original_message_id);
    if (chain) chain.push(row.id);
    else chains.set(row.original_message_id, [row.original_message_id, row.id]);
  }

  return c.json(
    visible.map(
      (row: Parameters<typeof mapMessage>[0] & { original_message_id?: string | null }) => {
        const versions = chains.get(row.original_message_id ?? row.id);
        return { ...mapMessage(row), ...(versions ? { versions } : {}) };
      },
    ),
  );
});

export { sessions };
