import type { Bindings } from "../../../types";
import { canFileDocuments } from "../../../types";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import { affordable, spend } from "../spend";
import { mayChangeThings } from "../role";
import { embeddingSpend, spends } from "../../entitlements";
import { embeddingModel } from "../../embeddings";
import { enqueueDocumentJob } from "../../docs/enqueue";

/**
 * Writing a long document, handed to the document engine.
 *
 * Before this tool, an agent asked for a report wrote it as a chat reply: 4,096
 * tokens a pass, several passes, and a row written only when the turn ended —
 * so a long one that died mid-way left nothing (covan-ai/covan-cloud#331). Now
 * the agent hands the request over and the turn ends in a sentence. The engine
 * outlines it and writes it a section at a time in the background
 * (`lib/docs/engine.ts`), the conversation shows it filling in, and it is filed
 * into the agent's reports bundle when it is done.
 *
 * No confirmation card. It changes nothing outside Covan and nothing a person
 * would want to stop before it starts — and it can be stopped from the card
 * while it is being written. It does spend, which is why `affordable` is
 * asked first, and it writes a document into the workspace, which is why a
 * viewer is refused: the reports bundle is shared, and a viewer may not add to
 * it (0021).
 */

const MAX_TITLE = 120;
const MAX_INSTRUCTION = 2000;
/**
 * What the model is asked to keep the brief to. Far below `MAX_INSTRUCTION`
 * on purpose: on 2026-10-15 a model put the whole report into this argument —
 * 4,380 output tokens streamed with nothing on screen for forty seconds — and
 * a second call like it was cut off mid-argument and never ran. The writer
 * reads the conversation itself; the brief only has to say what it is for.
 */
const BRIEF_CHARS = 600;

export const writeDocumentTool: AgentTool = {
  name: "write_document",
  description:
    "Write a long document — a report, a write-up, a proposal, a brief, meeting notes — " +
    "and file it in this agent's reports bundle, where the team can open, download " +
    "(Markdown, Word or PDF) and search it. Use this whenever somebody asks for a report or " +
    "a document, or for something longer than a chat answer should be. Do NOT write the " +
    "document in the chat yourself: call this, then tell them in a sentence or two that it " +
    "is being written and will appear in the conversation. A separate writer plans and writes " +
    "it section by section, and reads this whole conversation and the team's documents " +
    "itself — so `instruction` is a short brief, not the document: never put the content, " +
    "the outline or the text into it. To change a document that already exists — fix, update, " +
    "extend or reword it, including one written here — use edit_document instead of writing it " +
    "again. If the documents listed for this conversation already include the one being asked " +
    "about, do not call this again; point the person to its card.",
  input: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short working title naming the document's subject.",
        maxLength: MAX_TITLE,
      },
      instruction: {
        type: "string",
        description:
          "One to three sentences, in the person's own language: what the document is for, " +
          "who will read it, and any sections, length or tone they asked for. No more than " +
          `${BRIEF_CHARS} characters — the writer already has the conversation, so repeating it ` +
          "here only delays the document.",
        maxLength: MAX_INSTRUCTION,
      },
    },
    required: ["title", "instruction"],
    additionalProperties: false,
  },
  destructive: false,
  // The engine files into the document store, so a deployment with none
  // cannot finish a document — and offering a tool that can only fail is an
  // invitation to try.
  isConfigured: (env: ToolEnv) => canFileDocuments(env),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const record = (args ?? {}) as { title?: unknown; instruction?: unknown };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
    if (!title || !instruction) {
      return { kind: "error", message: "title and instruction are both required" };
    }
    if (!ctx.sessionId) {
      return {
        kind: "error",
        message: "documents can only be written from a conversation, not from a scheduled run",
      };
    }

    const refused = await affordable(ctx);
    if (refused) return refused;
    if (!(await mayChangeThings(ctx))) {
      return {
        kind: "error",
        message:
          "the person you are working for is a viewer in this workspace and cannot add " +
          "documents to it. Say so plainly; answer in the chat instead if that helps.",
      };
    }

    const { data: agent } = await ctx.db
      .from("agents")
      .select("id, name")
      .eq("id", ctx.agentId)
      .maybeSingle();
    if (!agent) return { kind: "error", message: "this agent could not be found" };

    const started = await enqueueDocumentJob({
      db: ctx.db,
      // The route hands the tool its whole env; `ToolEnv` names only what the
      // registry promises every surface. The document host needs the rest.
      env: ctx.env as unknown as Bindings,
      workspaceId: ctx.workspaceId,
      agent: { id: agent.id as string, name: agent.name as string },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      instruction: instruction.slice(0, MAX_INSTRUCTION),
      title: title.slice(0, MAX_TITLE),
      origin: "tool",
    });

    if (!started.ok) {
      return { kind: "error", message: `the document could not be started: ${started.reason}` };
    }

    await spend(
      ctx,
      spends(
        embeddingSpend(embeddingModel(ctx.env), started.embeddingTokens, "retrieval"),
        started.rerankSpend,
      ),
    );

    return {
      kind: "ok",
      content:
        `Started writing "${started.job.title}" (document job ${started.job.id}). It is being ` +
        "written section by section and will appear in this conversation as a document card, " +
        "then be filed in the reports bundle. Tell the person so in a sentence or two. Do not " +
        "write the document, or a draft of it, in your reply.",
    };
  },
};
