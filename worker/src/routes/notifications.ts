import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";

const notifications = new Hono<AppEnv>();

/**
 * Every notice defaults to on. A user who has never opened this screen must
 * keep hearing about a routine that died — silence is the failure these
 * messages exist to prevent.
 */
const DEFAULTS = { routinePaused: true, quotaExhausted: true };

const updateSchema = z
  .object({
    routinePaused: z.boolean().optional(),
    quotaExhausted: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

// GET /notification-preferences
notifications.get("/notification-preferences", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const { data, error } = await db
    .from("notification_preferences")
    .select("routine_paused, quota_exhausted")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("failed to load notification preferences", error);
    return c.json({ error: "failed to load your notification settings" }, 500);
  }
  // No row is the normal state, not an error: nobody has a row until they
  // change something.
  if (!data) return c.json(DEFAULTS);

  return c.json({
    routinePaused: data.routine_paused as boolean,
    quotaExhausted: data.quota_exhausted as boolean,
  });
});

// PATCH /notification-preferences
notifications.patch("/notification-preferences", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  // Upsert rather than update: the first change is also the first row. Written
  // through the caller's own client, so the insert and update policies are what
  // enforce "your own" — `user_id` is set from the verified token, never from
  // the body, so there is nothing here to forge.
  const row: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  if (parsed.data.routinePaused !== undefined) row.routine_paused = parsed.data.routinePaused;
  if (parsed.data.quotaExhausted !== undefined) row.quota_exhausted = parsed.data.quotaExhausted;

  const { data, error } = await db
    .from("notification_preferences")
    .upsert(row, { onConflict: "user_id" })
    .select("routine_paused, quota_exhausted")
    .maybeSingle();

  if (error || !data) {
    console.error("failed to save notification preferences", error);
    return c.json({ error: "failed to save your notification settings" }, 500);
  }

  return c.json({
    routinePaused: data.routine_paused as boolean,
    quotaExhausted: data.quota_exhausted as boolean,
  });
});

export { notifications, DEFAULTS };
