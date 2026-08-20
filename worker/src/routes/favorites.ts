import { Hono } from "hono";
import type { AppEnv } from "../types";

const favorites = new Hono<AppEnv>();

// POST /agents/:id/favorite — toggle
favorites.post("/agents/:id/favorite", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const agentId = c.req.param("id");

  const { data: existing, error: selectError } = await db
    .from("favorites")
    .select("agent_id")
    .eq("user_id", user.id)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (selectError) {
    return c.json({ error: "failed to load favorite" }, 500);
  }

  if (existing) {
    const { error } = await db
      .from("favorites")
      .delete()
      .eq("user_id", user.id)
      .eq("agent_id", agentId);

    if (error) {
      return c.json({ error: "failed to remove favorite" }, 500);
    }

    return c.json({ favorited: false });
  }

  const { error } = await db.from("favorites").insert({ user_id: user.id, agent_id: agentId });

  if (error) {
    return c.json({ error: "failed to add favorite" }, 500);
  }

  return c.json({ favorited: true });
});

// GET /favorites
favorites.get("/favorites", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db.from("favorites").select("agent_id").eq("user_id", user.id);

  if (error) {
    return c.json({ error: "failed to load favorites" }, 500);
  }

  return c.json(data.map((row) => row.agent_id as string));
});

export { favorites };
