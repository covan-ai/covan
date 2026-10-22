import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";

const notifications = new Hono<AppEnv>();

/**
 * Every notice defaults to on. A user who has never opened this screen must
 * keep hearing about a routine that died — silence is the failure these
 * messages exist to prevent.
 */
const DEFAULTS = {
  routinePaused: true,
  quotaExhausted: true,
  // 0128: the three switches under "Email me when" (A16).
  needsMeAway: true,
  routineFailed: true,
  weeklySummary: false,
};

const COLUMNS = "routine_paused, quota_exhausted, needs_me_away, routine_failed, weekly_summary";

function shape(row: Record<string, unknown>) {
  return {
    routinePaused: row.routine_paused as boolean,
    quotaExhausted: row.quota_exhausted as boolean,
    needsMeAway: row.needs_me_away as boolean,
    routineFailed: row.routine_failed as boolean,
    weeklySummary: row.weekly_summary as boolean,
  };
}

const updateSchema = z
  .object({
    routinePaused: z.boolean().optional(),
    quotaExhausted: z.boolean().optional(),
    needsMeAway: z.boolean().optional(),
    routineFailed: z.boolean().optional(),
    weeklySummary: z.boolean().optional(),
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
    .select(COLUMNS)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("failed to load notification preferences", error);
    return c.json({ error: "failed to load your notification settings" }, 500);
  }
  // No row is the normal state, not an error: nobody has a row until they
  // change something.
  if (!data) return c.json(DEFAULTS);

  return c.json(shape(data));
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
  if (parsed.data.needsMeAway !== undefined) row.needs_me_away = parsed.data.needsMeAway;
  if (parsed.data.routineFailed !== undefined) row.routine_failed = parsed.data.routineFailed;
  if (parsed.data.weeklySummary !== undefined) row.weekly_summary = parsed.data.weeklySummary;

  const { data, error } = await db
    .from("notification_preferences")
    .upsert(row, { onConflict: "user_id" })
    .select(COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error("failed to save notification preferences", error);
    return c.json({ error: "failed to save your notification settings" }, 500);
  }

  return c.json(shape(data));
});

export { notifications, DEFAULTS };
