import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { toEpochMs } from "../lib/dto";

/**
 * A request an agent made while nobody was watching (0143): read it, and
 * answer it.
 *
 * This is where the email's link opens and where the Inbox's buttons post.
 * Answering only writes the answer; the cron carries on with it on its next
 * tick (`lib/approvals/dispatch.ts`), so the page says "approved, carrying on"
 * rather than showing a result it does not have yet.
 *
 * **Who may answer is Postgres's call.** Both handlers go through the
 * caller's own client: the read is whatever `paused_turns`' policies let them
 * see (their own, or as an admin a routine's), and the answer is
 * `answer_approval`, a definer function that decides owner-or-admin itself
 * and refuses a conversation's question, a second answer and an expired one.
 * Nothing here reaches for the service role.
 */

const approvals = new Hono<AppEnv>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The columns 0060 and 0143 grant: the card and its answer, never the prompt. */
const COLUMNS =
  "id, origin, tool, summary, proposal, status, expires_at, created_at, resolved_at, " +
  "resolved_by, resolved_via, resumed_at, user_id, agent_id, routine_run_id, session_id";

type Row = {
  id: string;
  origin: string;
  tool: string;
  summary: string | null;
  proposal: unknown;
  status: string;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_via: string | null;
  resumed_at: string | null;
  user_id: string;
  agent_id: string;
  routine_run_id: string | null;
  session_id: string;
};

// GET /approvals/:id
approvals.get("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "no such request" }, 404);
  const db = c.get("db");
  const caller = c.get("user").id;

  const { data, error } = await db.from("paused_turns").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    console.error("could not read a request", error.code);
    return c.json({ error: "failed to load that request" }, 500);
  }
  if (!data) return c.json({ error: "no such request" }, 404);
  const row = data as unknown as Row;

  // The names around it, each a read the caller may or may not be allowed:
  // an admin reading somebody's private routine sees the request and not the
  // routine's name, and the page says "a routine" instead.
  const people = [row.user_id, row.resolved_by].filter((v): v is string => Boolean(v));
  const [agent, profiles, run] = await Promise.all([
    db.from("agents").select("id, name").eq("id", row.agent_id).maybeSingle(),
    db.from("profiles").select("id, name").in("id", people),
    row.routine_run_id
      ? db.from("routine_runs").select("routine_id").eq("id", row.routine_run_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const routineId = (run.data as { routine_id?: string } | null)?.routine_id ?? null;
  const routine = routineId
    ? (await db.from("routines").select("id, name").eq("id", routineId).maybeSingle()).data
    : null;
  const nameOf = (who: string | null) =>
    who
      ? (((profiles.data ?? []).find((p) => (p as { id: string }).id === who) as
          { id: string; name: string | null } | undefined) ?? { id: who, name: null })
      : null;

  const mine = row.user_id === caller;
  const open = row.status === "pending" && Date.parse(row.expires_at) > Date.now();
  return c.json({
    approval: {
      id: row.id,
      origin: row.origin,
      tool: row.tool,
      summary: row.summary ?? "",
      proposal: row.proposal ?? null,
      status: row.status,
      expiresAt: toEpochMs(row.expires_at),
      createdAt: toEpochMs(row.created_at),
      resolvedAt: row.resolved_at ? toEpochMs(row.resolved_at) : null,
      resolvedVia: row.resolved_via,
      resumedAt: row.resumed_at ? toEpochMs(row.resumed_at) : null,
      mine,
      // What `answer_approval` will accept, so the page offers no button it
      // would refuse. Somebody who can read a routine's request without it
      // being theirs can only be an admin (0143's policy); a conversation's
      // question is answered in the conversation.
      canAnswer: open && row.origin !== "chat" && (mine || row.origin === "routine"),
      // The conversation is the owner's own; an admin is not sent into it.
      sessionId: mine ? row.session_id : null,
      agent: agent.data ? { id: String(agent.data.id), name: String(agent.data.name ?? "") } : null,
      routine: routine ? { id: String(routine.id), name: String(routine.name ?? "") } : null,
      owner: nameOf(row.user_id),
      resolvedBy: nameOf(row.resolved_by),
    },
  });
});

const answerSchema = z.object({ approve: z.boolean() });

// POST /approvals/:id/answer
approvals.post("/approvals/:id/answer", async (c) => {
  // A yes is a person's, and what it sets off outlives any key.
  const refusal = refuseIfKeyAuthenticated(c, "answer what an agent asked");
  if (refusal) return c.json(refusal, 403);

  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "no such request" }, 404);
  const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { data, error } = await c
    .get("db")
    .rpc("answer_approval", { p_id: id, p_approve: parsed.data.approve });
  if (error) {
    if (error.code === "P0002") return c.json({ error: "no such request" }, 404);
    if (error.code === "42501") return c.json({ error: "this is not yours to answer" }, 403);
    if (error.code === "22023") {
      return c.json({ error: "answer this in its conversation", code: "in_conversation" }, 409);
    }
    console.error("could not answer a request", error.code);
    return c.json({ error: "failed to answer that request" }, 500);
  }
  if (data === "already") return c.json({ error: "this was already answered" }, 409);
  if (data === "expired") return c.json({ error: "this request has expired" }, 410);
  return c.json({ status: data });
});

export { approvals };
