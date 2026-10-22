import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { toEpochMs } from "../lib/dto";

/**
 * The Inbox (A4, A20): every thread the caller can see, newest activity first,
 * with what each one wants from them.
 *
 * The arithmetic is `inbox_rows` and `inbox_counts` (0122), security invoker,
 * so every row is one the policies already let this person read; this file
 * shapes it for the screen and decides what the one line under a title says:
 * the question when a reply asked one, the step when a turn is running, else
 * the newest message.
 */
const inbox = new Hono<AppEnv>();

const FILTERS = ["all", "unread", "needs_you", "running", "mine"] as const;

const listQuery = z.object({
  filter: z.enum(FILTERS).optional(),
  agent: z.string().uuid().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type InboxNeedsYou = {
  kind: "approval" | "question" | "login" | "routine_failed";
  pausedTurnId?: string;
  summary: string;
  replies?: string[];
  since: number;
};

export type InboxItemDTO = {
  sessionId: string;
  agentId: string;
  title: string | null;
  kind: string;
  visibility: "private" | "shared";
  ownerId: string | null;
  ownerName: string | null;
  /** The owner's name when the thread is somebody else's, shared with you. */
  sharedBy: string | null;
  preview: {
    role: "user" | "assistant";
    senderName: string | null;
    text: string;
    at: number;
  } | null;
  unread: boolean;
  unreadCount: number;
  needsYou: InboxNeedsYou | null;
  running: {
    stepsDone: number;
    lastTool: string | null;
    note: string | null;
    since: number;
  } | null;
  lastActivityAt: number;
};

export type InboxCountsDTO = {
  unread: number;
  needsYou: number;
  running: number;
  byAgent: Record<string, { unread: number; needsYou: number; running: number }>;
};

type Row = {
  session_id: string;
  agent_id: string;
  title: string | null;
  kind: string;
  visibility: string;
  owner_id: string | null;
  owner_name: string | null;
  last_activity_at: string;
  preview_role: string | null;
  preview_sender_id: string | null;
  preview_sender_name: string | null;
  preview_text: string | null;
  preview_at: string | null;
  unread_count: number;
  needs_kind: string | null;
  needs_paused_turn_id: string | null;
  needs_summary: string | null;
  needs_replies: unknown;
  needs_since: string | null;
  running_steps: number | null;
  running_tool: string | null;
  running_note: string | null;
  running_since: string | null;
};

/**
 * The newest message as one line: Markdown's marks taken off, whitespace
 * folded, so "## Summary\n\n- **Window:** 30 days" reads "Summary Window: 30
 * days" rather than as symbols.
 */
export function plainLine(text: string, max = 200): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const NEEDS_KINDS = new Set(["approval", "question", "login", "routine_failed"]);

export function mapInboxRow(row: Row, callerId: string): InboxItemDTO {
  const needsKind = row.needs_kind && NEEDS_KINDS.has(row.needs_kind) ? row.needs_kind : null;
  const needsYou: InboxNeedsYou | null = needsKind
    ? {
        kind: needsKind as InboxNeedsYou["kind"],
        ...(row.needs_paused_turn_id ? { pausedTurnId: row.needs_paused_turn_id } : {}),
        summary:
          needsKind === "login" && row.needs_summary
            ? `Needs you to sign in to ${row.needs_summary}`
            : (row.needs_summary ?? ""),
        ...(Array.isArray(row.needs_replies)
          ? {
              replies: row.needs_replies.filter((r): r is string => typeof r === "string"),
            }
          : {}),
        since: toEpochMs(row.needs_since ?? row.last_activity_at),
      }
    : null;
  const running = row.running_since
    ? {
        stepsDone: row.running_steps ?? 0,
        lastTool: row.running_tool,
        note: row.running_note,
        since: toEpochMs(row.running_since),
      }
    : null;

  // What the line under the title says: what the agent is asking, what it is
  // doing, or what was said last.
  let text = row.preview_text ? plainLine(row.preview_text) : "";
  if (needsKind === "question" && row.needs_summary) text = row.needs_summary;
  else if (running?.note) text = running.note;

  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    title: row.title,
    kind: row.kind,
    visibility: row.visibility === "shared" ? "shared" : "private",
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    sharedBy: row.owner_id && row.owner_id !== callerId ? row.owner_name : null,
    preview: row.preview_at
      ? {
          role: row.preview_role === "assistant" ? "assistant" : "user",
          senderName: row.preview_sender_name,
          text,
          at: toEpochMs(row.preview_at),
        }
      : null,
    unread: row.unread_count > 0,
    unreadCount: row.unread_count,
    needsYou,
    running,
    lastActivityAt: toEpochMs(row.last_activity_at),
  };
}

export function sumCounts(
  rows: Array<{ agent_id: string; unread: number; needs_you: number; running: number }>,
): InboxCountsDTO {
  const counts: InboxCountsDTO = { unread: 0, needsYou: 0, running: 0, byAgent: {} };
  for (const r of rows) {
    counts.unread += r.unread;
    counts.needsYou += r.needs_you;
    counts.running += r.running;
    counts.byAgent[r.agent_id] = { unread: r.unread, needsYou: r.needs_you, running: r.running };
  }
  return counts;
}

async function readCounts(
  db: AppEnv["Variables"]["db"],
  workspaceId: string,
): Promise<InboxCountsDTO | null> {
  const { data, error } = await db.rpc("inbox_counts", { p_workspace_id: workspaceId });
  if (error) {
    console.error("inbox_counts failed", error);
    return null;
  }
  return sumCounts((data ?? []) as Parameters<typeof sumCounts>[0]);
}

// GET /inbox
inbox.get("/inbox", async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const db = c.get("db");
  const limit = parsed.data.limit ?? 50;
  const [rows, counts] = await Promise.all([
    db.rpc("inbox_rows", {
      p_workspace_id: workspaceId,
      p_filter: parsed.data.filter ?? "all",
      p_agent_id: parsed.data.agent ?? null,
      p_before: parsed.data.before ? new Date(parsed.data.before).toISOString() : null,
      // One more than asked, to say whether there is a next page.
      p_limit: limit + 1,
      p_session_ids: null,
    }),
    readCounts(db, workspaceId),
  ]);
  if (rows.error || !counts) {
    if (rows.error) console.error("inbox_rows failed", rows.error);
    return c.json({ error: "failed to load the inbox" }, 500);
  }

  const all = (rows.data ?? []) as Row[];
  const userId = c.get("user").id;
  return c.json({
    items: all.slice(0, limit).map((r) => mapInboxRow(r, userId)),
    counts: { unread: counts.unread, needsYou: counts.needsYou, running: counts.running },
    perAgentUnread: Object.fromEntries(
      Object.entries(counts.byAgent).map(([id, n]) => [id, n.unread]),
    ),
    hasMore: all.length > limit,
  });
});

// GET /inbox/counts — the sidebar's Inbox count and dots, polled.
inbox.get("/inbox/counts", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ unread: 0, needsYou: 0, running: 0, byAgent: {} });
  const counts = await readCounts(c.get("db"), workspaceId);
  if (!counts) return c.json({ error: "failed to count the inbox" }, 500);
  return c.json(counts);
});

const readSchema = z.object({ sessionId: z.string().uuid() });

// POST /inbox/read — the thread was opened, or a reply finished while it was.
inbox.post("/inbox/read", async (c) => {
  const parsed = readSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const db = c.get("db");
  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("id, workspace_id")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();
  if (sessionError) return c.json({ error: "failed to load the thread" }, 500);
  if (!session) return c.json({ error: "not found" }, 404);

  const { error } = await db.from("session_reads").upsert(
    {
      session_id: session.id,
      user_id: c.get("user").id,
      workspace_id: session.workspace_id,
      last_read_at: new Date().toISOString(),
    },
    { onConflict: "session_id,user_id" },
  );
  if (error) {
    console.error("could not mark a thread read", error);
    return c.json({ error: "failed to mark the thread read" }, 500);
  }
  return c.json({ ok: true });
});

// POST /inbox/read-all — "Mark all read".
inbox.post("/inbox/read-all", async (c) => {
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);
  const { data, error } = await c
    .get("db")
    .rpc("mark_all_sessions_read", { p_workspace_id: workspaceId });
  if (error) {
    console.error("mark_all_sessions_read failed", error);
    return c.json({ error: "failed to mark the inbox read" }, 500);
  }
  return c.json({ ok: true, marked: typeof data === "number" ? data : 0 });
});

export { inbox };
