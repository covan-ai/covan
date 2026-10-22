import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";

const search = new Hono<AppEnv>();

// GET /search/messages?q=query
//
// Full-text search across messages the caller can read. RLS
// (`messages_select_session_visible`, 0031) already narrows to sessions they
// own or are shared into, so no additional workspace scope is needed — the
// query's own `from("messages").select()` is already filtered.
//
// Postgres full-text (`to_tsvector`) rather than embedding search. Semantic
// search is a different product decision, and the infra for it exists but is
// deliberately not wired here.
search.get("/search/messages", async (c) => {
  const db = c.get("db");

  const parsed = z
    .object({
      q: z.string().min(1).max(200),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .safeParse(c.req.query());

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { q, limit = 20 } = parsed.data;

  // Postgres full-text: `to_tsvector('english', content)` against
  // `plainto_tsquery('english', query)`. The `english` config stems words
  // (searching "running" finds "run") and drops stop words.
  //
  // `ts_rank` orders by relevance; `created_at desc` is the tiebreaker so
  // newer results come first when relevance is equal.
  const { data, error } = await db
    .from("messages")
    .select("*, sender:profiles(id,name,avatar_url), session:chat_sessions(id,title,agent_id)")
    .textSearch("content", q, { type: "plain", config: "english" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return c.json({ error: "failed to search messages" }, 500);
  }

  // Each hit says which thread it is in, so the ⌘K palette can open it.
  return c.json(
    (data ?? []).map((row) => {
      const session = (Array.isArray(row.session) ? row.session[0] : row.session) as {
        id: string;
        title: string | null;
        agent_id: string;
      } | null;
      return {
        ...mapMessage(row),
        sessionId: (row.session_id as string | undefined) ?? session?.id ?? null,
        agentId: session?.agent_id ?? null,
        sessionTitle: session?.title ?? null,
      };
    }),
  );
});

export { search };
