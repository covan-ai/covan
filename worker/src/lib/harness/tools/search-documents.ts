import { retrieveForAgent } from "../../retrieval";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * The first tool, and the one that proves the loop without taking any risk.
 *
 * It asks for no credential, reaches nothing outside Covan, and reads exactly
 * what the chat route already reads for every turn — `retrieveForAgent`,
 * unchanged. So if the harness is wrong, this is where it is visibly wrong,
 * and nothing is at stake while it is being found out.
 *
 * It is also genuinely useful and not a demo. Retrieval on a chat turn
 * happens once, against the question as asked; this lets the agent ask again
 * in its own words when the first answer was thin — which is the single
 * commonest reason a grounded answer is worse than it should be.
 */
export const searchDocumentsTool: AgentTool = {
  name: "search_documents",
  description:
    "Search the documents this team has shared with you and get back the passages that " +
    "match. Use it when the material already in front of you does not cover the question, " +
    "or to look up a second thing the question depends on. Phrase the query as the words " +
    "you expect to find in the document, not as a question.",
  input: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for, in the wording you expect the document to use.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  destructive: false,
  // Needs nothing this build might not have: retrieval falls back to
  // persona-only on its own, and an agent with no documents gets an empty
  // answer rather than an error.
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const query = (args as { query?: unknown }).query;
    if (typeof query !== "string" || !query.trim()) {
      return { kind: "error", message: "query is required and must be a non-empty string" };
    }

    const { ragBlock, sources } = await retrieveForAgent(
      ctx.db,
      ctx.env,
      ctx.agentId,
      query,
      // No history. This is a question the agent asked itself, in its own
      // words, so there is no earlier turn carrying its subject — which is
      // the only thing `retrieveForAgent` reads history for.
      [],
    );

    if (!ragBlock.trim()) {
      return {
        kind: "ok",
        content:
          "No passage matched that. Try different wording, or say that the documents do not " +
          "cover it rather than answering from memory.",
      };
    }

    const cited = sources.map((s) => s.name).filter(Boolean);
    return {
      kind: "ok",
      content: cited.length > 0 ? `${ragBlock}\n\nFrom: ${cited.join(", ")}` : ragBlock,
    };
  },
};
