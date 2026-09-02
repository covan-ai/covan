import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { resolveModel } from "../lib/models";
import { complete, totalTokens } from "../lib/completion";
import { buildIdeaExtractionMessages, parseIdeaSuggestions } from "../lib/idea-suggest";
import { guardQuota, recordQuota } from "../lib/entitlements/guard";

const brainstorm = new Hono<AppEnv>();

const suggestSchema = z.object({ sessionId: z.string().min(1) });

// How many recent messages to feed the extractor. A brainstorm is short-lived;
// the last 30 turns capture the ideas raised without inflating the prompt.
const EXTRACT_MSG_LIMIT = 30;

// POST /brainstorm/ideas/suggest — distill the conversation so far into
// candidate idea cards. Nothing is persisted; the client adds the ones it wants.
brainstorm.post("/brainstorm/ideas/suggest", async (c) => {
  const db = c.get("db");

  const denied = await guardQuota(c);
  if (denied) return denied;

  const parsed = suggestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const { sessionId } = parsed.data;

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("agent_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) {
    return c.json({ error: "failed to load session" }, 500);
  }
  if (!session) {
    return c.json({ error: "not found" }, 404);
  }

  const { data: agent } = await db
    .from("agents")
    .select("model")
    .eq("id", session.agent_id)
    .maybeSingle();

  const { data: recentDesc, error: messagesError } = await db
    .from("messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(EXTRACT_MSG_LIMIT);
  if (messagesError) {
    return c.json({ error: "failed to load messages" }, 500);
  }

  const rows = (recentDesc ?? []).slice().reverse();
  if (rows.length === 0) {
    return c.json({ ideas: [] });
  }

  const transcript = rows
    .map(
      (m: { role: string; content: string }) =>
        `${m.role === "assistant" ? "Agent" : "User"}: ${m.content}`,
    )
    .join("\n");

  try {
    const { text, usage } = await complete(c.env, {
      model: resolveModel(agent?.model ?? null, c.env),
      messages: buildIdeaExtractionMessages(transcript),
      json: true,
      maxTokens: 800,
    });
    await recordQuota(c, totalTokens(usage));
    return c.json({ ideas: parseIdeaSuggestions(text) });
  } catch (err) {
    console.error("idea extraction failed", err);
    return c.json({ error: "failed to extract ideas" }, 502);
  }
});

export { brainstorm };
