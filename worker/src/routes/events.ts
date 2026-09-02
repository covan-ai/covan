import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { getActiveWorkspaceId } from "../lib/workspace";
import { toEpochMs } from "../lib/dto";

const events = new Hono<AppEnv>();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** ISO timestamp; returns events strictly older than this. */
  before: z.string().datetime().optional(),
});

type EventRow = {
  id: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  subject_label: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  actor: { name: string | null; email: string | null } | null;
};

/**
 * GET /events — the workspace's record of who did what.
 *
 * No workspace scope in the query beyond the active one, and no role check
 * here: `workspace_events_select_admin` is the boundary, and it admits only an
 * admin of the row's workspace. A member gets an empty list rather than a 403,
 * which is the one place this differs from /trash — there, an empty list would
 * be a false statement about whether anything is recoverable. Here it is true:
 * there is nothing this person may see.
 *
 * Paged by `before` rather than by offset. The rows are written by triggers
 * while somebody is reading, and an offset page would skip or repeat rows as
 * the log grows underneath it.
 */
events.get("/events", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid query" }, 400);
  }
  const { limit, before } = parsed.data;

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ events: [], hasMore: false });

  let query = db
    .from("workspace_events")
    .select(
      "id,action,subject_type,subject_id,subject_label,detail,created_at,actor:profiles(name,email)",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    // One more than asked for, so "is there another page" is answered without a
    // second count query against a table that is growing as this runs.
    .limit(limit + 1);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;

  if (error) {
    console.error("failed to load workspace events", error);
    return c.json({ error: "failed to load activity" }, 500);
  }

  const rows = (data ?? []) as unknown as EventRow[];
  const hasMore = rows.length > limit;

  return c.json({
    hasMore,
    events: rows.slice(0, limit).map((r) => ({
      id: r.id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      subjectLabel: r.subject_label,
      detail: r.detail,
      createdAt: toEpochMs(r.created_at),
      /**
       * The ISO string as well, because `before` on the next page has to be a
       * timestamp Postgres will compare against `created_at` — and a number
       * round-tripped through the client would lose the microseconds Postgres
       * keeps, which is how a paged log repeats or skips its boundary row.
       */
      cursor: r.created_at,
      // Null for anything the system did on nobody's behalf, and for an actor
      // whose account has since been deleted — `actor_id` nulls rather than
      // cascading, so the event survives the person.
      actor: r.actor ? (r.actor.name ?? r.actor.email) : null,
    })),
  });
});

export { events };
