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
/**
 * What an empty search says, and why it no longer ends by inviting another one.
 *
 * It used to close with "Try different wording", and models do exactly that.
 * The most expensive turn on record before the caching work was eight
 * `search_documents` calls, five of them empty; calibrating the eval produced a
 * sample that ran eight searches and never reached the database it needed,
 * with the judge naming the looping as what lost it. `find_tool` had the same
 * sentence and the same behaviour beside it, so this was a pattern across two
 * tools rather than one tool's phrasing.
 *
 * The replacement still leaves the door open — sometimes a second search with
 * genuinely different words is right — but it says what the first attempt
 * settled, and it names the alternatives rather than only the retry. A model
 * that has looked twice needs to hear that looking a third time is the
 * unlikely option, not the default one.
 *
 * Exported because `eval/cases.ts` replays this string as a fixture and its
 * comment called it verbatim while nothing checked that it was. A copy the
 * compiler does not hold is a copy that goes stale exactly when it matters:
 * on the change whose effect the eval was built to see.
 */
export const NO_PASSAGE_MATCHED =
  "No passage matched that. The documents reached by this search do not appear to cover " +
  "it. Prefer another source if the question allows one, or tell the person the documents " +
  "do not cover it rather than answering from memory. Search again only with genuinely " +
  "different words, and not more than once — repeating a search that found nothing is the " +
  "single most expensive thing you can do here.";

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
      return { kind: "ok", content: NO_PASSAGE_MATCHED };
    }

    const cited = sources.map((s) => s.name).filter(Boolean);
    return {
      kind: "ok",
      content: cited.length > 0 ? `${ragBlock}\n\nFrom: ${cited.join(", ")}` : ragBlock,
    };
  },
};
