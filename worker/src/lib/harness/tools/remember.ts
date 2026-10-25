import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import { mayChangeThings } from "../role";
import { NOTE_CHARS } from "../../team-block";

/**
 * One number, declared where the block that reads the notes lives. A note the
 * block would cut is a note this tool should have refused.
 */
export { NOTE_CHARS } from "../../team-block";

/** Per person, per workspace, in their own (`owner`) notes. */
export const MAX_OWNER_NOTES = 100;
/** Per workspace, in the notes everybody's agents are given. */
export const MAX_WORKSPACE_NOTES = 200;

/**
 * Where a note is kept, decided here and never by the model.
 *
 * A note is the workspace's only when it is about the team, the thread it was
 * said in is shared with the workspace, and the person may write there. Every
 * other combination stays with the person who said it: a private thread is
 * private, a viewer cannot add to what the whole team's agents are told, and
 * a fact about one person is not the team's to read.
 */
export function scopeFor(
  about: "person" | "team",
  ctx: Pick<ToolContext, "sessionShared" | "db" | "workspaceId" | "userId">,
  canWrite: boolean,
): "owner" | "workspace" {
  return about === "team" && ctx.sessionShared === true && canWrite ? "workspace" : "owner";
}

const WHERE = "Settings › Memory";

export const rememberTool: AgentTool = {
  name: "remember",
  description:
    "Keep one short thing in mind for next time: a lasting preference the person states " +
    "(how they like answers, which language), a lasting fact about their work (what they " +
    "own, who they are), or how this team works (its tools, rhythms, words, decisions). " +
    'Use `about: "person"` for the first two and `"team"` for the last. Never for a ' +
    "one-off instruction, a secret, a password, anything about health or private life, or " +
    "something already in your notes. At most two per reply, each under 280 characters, in " +
    "the person's own language. They can see and remove every note under Settings › Memory.",
  input: {
    type: "object",
    properties: {
      text: {
        type: "string",
        maxLength: NOTE_CHARS,
        description: "The one thing to keep in mind, as a short plain sentence.",
      },
      about: {
        type: "string",
        enum: ["person", "team"],
        description: '"person" for this person, "team" for how the team works.',
      },
    },
    required: ["text", "about"],
    additionalProperties: false,
  },
  destructive: false,
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { text: raw, about } = (args ?? {}) as { text?: unknown; about?: unknown };
    if (about !== "person" && about !== "team") {
      return { kind: "error", message: 'about must be "person" or "team"' };
    }
    if (typeof raw !== "string" || !raw.trim()) {
      return { kind: "error", message: "text is required and must be a non-empty string" };
    }
    // Refused, not cut: half a sentence kept in mind is worse than none, and
    // the model can say it again shorter.
    const text = raw.trim();
    if (text.length > NOTE_CHARS) {
      return {
        kind: "error",
        message: `That note is ${text.length} characters and the limit is ${NOTE_CHARS}. Say it again, shorter.`,
      };
    }
    if (!ctx.sessionId) {
      return { kind: "error", message: "A note can only be kept in a conversation." };
    }

    // Asked only when it can change the answer.
    const canWrite =
      about === "team" && ctx.sessionShared === true ? await mayChangeThings(ctx) : false;
    const scope = scopeFor(about, ctx, canWrite);

    let count = ctx.db
      .from("memory_notes")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", ctx.workspaceId);
    if (scope === "owner") count = count.eq("created_by", ctx.userId);
    const { count: have, error: countError } = await count.eq("scope", scope);
    if (countError) {
      console.error("could not count memory notes", countError);
      return { kind: "error", message: "Could not keep that note just now." };
    }
    const cap = scope === "owner" ? MAX_OWNER_NOTES : MAX_WORKSPACE_NOTES;
    if ((have ?? 0) >= cap) {
      return {
        kind: "error",
        message:
          `There is no room for another ${scope === "owner" ? "note of theirs" : "team note"}: ` +
          `${cap} are already kept. Tell the person, and that they can remove old ones under ${WHERE}.`,
      };
    }

    const { error } = await ctx.db.from("memory_notes").insert({
      workspace_id: ctx.workspaceId,
      created_by: ctx.userId,
      about,
      scope,
      text,
      source: "agent",
      source_session_id: ctx.sessionId,
    });
    if (error) {
      if (error.code === "23505") {
        return { kind: "ok", content: `Already noted: "${text}"` };
      }
      console.error("could not keep memory note", error);
      return { kind: "error", message: "Could not keep that note just now." };
    }

    const who = scope === "workspace" ? "for the team" : "for this person only";
    return {
      kind: "ok",
      content: `Noted ${who}: "${text}" They can see and remove it under ${WHERE}.`,
    };
  },
};
