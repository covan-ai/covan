import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { callerWorkspaceId } from "../lib/workspace";
import { NOTE_CHARS, capFor, countNotes } from "../lib/harness/tools/remember";

const memory = new Hono<AppEnv>();

const WHERE = "Settings › Memory";
const COLUMNS = "id, about, scope, text, source, created_by, created_at";

/**
 * What `/memory` says about a note. `created_by` and `source_session_id` stay
 * behind: `mine` is all the page needs of the first, and the thread a note was
 * said in is nobody else's to learn.
 */
type MemoryNote = {
  id: string;
  about: "person" | "team";
  scope: "owner" | "workspace";
  text: string;
  source: "agent" | "person";
  mine: boolean;
  createdAt: number;
};

function toNote(row: Record<string, unknown>, userId: string): MemoryNote {
  return {
    id: row.id as string,
    about: row.about as MemoryNote["about"],
    scope: row.scope as MemoryNote["scope"],
    text: row.text as string,
    source: row.source as MemoryNote["source"],
    mine: row.created_by === userId,
    createdAt: Date.parse(row.created_at as string),
  };
}

// Refused rather than cut, as the agent's tool refuses: half a sentence kept
// in mind is worse than none, and the limit is named so the person knows which
// end to shorten. 0138's check says the same number, but its answer is a 500.
const text = z
  .string({ message: "A note is text." })
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "A note cannot be empty.")
      .max(NOTE_CHARS, `A note is at most ${NOTE_CHARS} characters. Say it shorter.`),
  );

const createSchema = z.object({
  text,
  about: z.enum(["person", "team"], { message: 'about must be "person" or "team".' }),
});

// Only what 0138 lets a client change. Sharing goes one way, so "owner" is not
// a value; every other key is refused rather than ignored, so a client that
// thinks it can move `about` or the author finds out.
const patchSchema = z
  .object({ text: text.optional(), scope: z.literal("workspace").optional() })
  .strict()
  .refine((b) => b.text !== undefined || b.scope !== undefined, {
    message: 'Send the new text, or scope "workspace" to share.',
  });

const idSchema = z.string().uuid();

function whyNot(error: z.ZodError): string {
  return error.issues[0]?.message ?? "invalid request";
}

const noRoom = (cap: number, scope: "owner" | "workspace") =>
  `There is no room for another ${scope === "owner" ? "note of yours" : "team note"}: ` +
  `${cap} are already kept. Remove one you no longer need under ${WHERE} first.`;

const ALREADY = "That is already noted.";

// GET /memory — what this person may read, newest first.
//
// The workspace is named explicitly; which of its notes come back is the
// select policy's: every shared one, and the caller's own private ones.
memory.get("/memory", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ notes: [] });

  const { data, error } = await db
    .from("memory_notes")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) {
    console.error("could not list memory notes", error);
    return c.json({ error: "failed to load notes" }, 500);
  }
  return c.json({ notes: (data ?? []).map((r) => toNote(r as Record<string, unknown>, user.id)) });
});

// POST /memory — a note the person wrote themselves.
//
// `about` decides where it is kept, as it does for the agent's tool, except
// that nobody here is mid-conversation: a note about the team is the team's.
// A viewer may not write that, and is told before anything is counted. The
// insert policy says the same, and its refusal is mapped to the same answer.
memory.post("/memory", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "write what an agent is told to keep in mind");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: whyNot(parsed.error) }, 400);
  const { text: note, about } = parsed.data;

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const scope = about === "team" ? "workspace" : "owner";

  if (scope === "workspace") {
    const { data: canWrite } = await db.rpc("can_write_in_workspace", {
      p_workspace_id: workspaceId,
    });
    if (canWrite === false) {
      return c.json({ error: "Viewers cannot add to what the whole team's agents are told." }, 403);
    }
  }

  const { have, failed } = await countNotes(db, { workspaceId, scope, userId: user.id });
  if (failed) return c.json({ error: "failed to keep the note" }, 500);
  const cap = capFor(scope);
  if (have >= cap) return c.json({ error: noRoom(cap, scope) }, 409);

  const { data, error } = await db
    .from("memory_notes")
    .insert({
      workspace_id: workspaceId,
      created_by: user.id,
      about,
      scope,
      text: note,
      source: "person",
      source_session_id: null,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === "23505") return c.json({ error: ALREADY }, 409);
    if (error?.code === "42501") {
      return c.json({ error: "You cannot add to the team's notes here." }, 403);
    }
    console.error("could not keep memory note", error);
    return c.json({ error: "failed to keep the note" }, 500);
  }

  return c.json(toNote(data as Record<string, unknown>, user.id), 201);
});

// PATCH /memory/:id — correct the sentence, or share it with the team.
//
// Which notes this person may touch, and which changes of scope are allowed,
// are the policies' and 0138's trigger's to say; a row they hide is a 404, the
// same as one that is not there. The one rule kept here is the room in the
// workspace's shared notes, which Postgres does not count.
memory.patch("/memory/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "change what an agent is told to keep in mind");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not found" }, 404);

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: whyNot(parsed.error) }, 400);
  const { text: note, scope } = parsed.data;

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "not found" }, 404);

  if (scope === "workspace") {
    // Without the note itself: one that is shared already is not asking for
    // another place.
    const { have, failed } = await countNotes(db, {
      workspaceId,
      scope,
      userId: user.id,
      exceptId: id.data,
    });
    if (failed) return c.json({ error: "failed to update the note" }, 500);
    const cap = capFor("workspace");
    if (have >= cap) return c.json({ error: noRoom(cap, "workspace") }, 409);
  }

  const { data, error } = await db
    .from("memory_notes")
    .update({
      ...(note !== undefined ? { text: note } : {}),
      ...(scope !== undefined ? { scope } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id.data)
    .eq("workspace_id", workspaceId)
    .select(COLUMNS);
  if (error) {
    if (error.code === "23505") return c.json({ error: ALREADY }, 409);
    if (error.code === "42501") {
      return c.json({ error: "Only the person who wrote a note can share it." }, 403);
    }
    // 0138's check: a note about a person is never shared.
    if (error.code === "23514") {
      return c.json({ error: "A note about a person stays with that person." }, 400);
    }
    console.error("could not update memory note", error);
    return c.json({ error: "failed to update the note" }, 500);
  }
  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) return c.json({ error: "not found" }, 404);

  return c.json(toNote(updated as Record<string, unknown>, user.id));
});

// DELETE /memory/:id — nothing deleted is a 404, not a 204: a note the
// policies hide cannot be told apart from one that was never there.
memory.delete("/memory/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "delete what an agent is told to keep in mind");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");

  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not found" }, 404);

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "not found" }, 404);

  const { data, error } = await db
    .from("memory_notes")
    .delete()
    .eq("id", id.data)
    .eq("workspace_id", workspaceId)
    .select("id");
  if (error) {
    console.error("could not delete memory note", error);
    return c.json({ error: "failed to delete the note" }, 500);
  }
  if (!Array.isArray(data) || data.length === 0) return c.json({ error: "not found" }, 404);

  return c.body(null, 204);
});

export { memory };
