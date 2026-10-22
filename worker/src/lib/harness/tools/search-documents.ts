import { retrieveForAgent } from "../../retrieval";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import { spend } from "../spend";
import { embeddingSpend, spends } from "../../entitlements";
import { embeddingModel } from "../../embeddings";
import { connectionsOffFor, listConnections } from "../connections";

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

/**
 * The same, for a workspace that has connected apps — which are named, because
 * "another source" was not enough of a hint.
 *
 * A person connected Notion, asked "look at my Notion page", and the agent
 * searched the documents twice, found nothing, and told them it could not see
 * Notion — then, asked again, that Notion did not cover it. `find_tool` and
 * `run_tool` were offered on every one of those turns and Notion was in the
 * manifest; nothing was ever called. A connected app's contents are never in
 * these documents, so an empty search is exactly the moment to say where they
 * are, by name.
 */
export function noPassageMatched(apps: string[]): string {
  if (apps.length === 0) return NO_PASSAGE_MATCHED;
  return (
    `${NO_PASSAGE_MATCHED} This search reads only the documents in Covan, never a connected ` +
    `app. Connected here: ${apps.join(", ")}. If the question is about what is in one of ` +
    "them, use find_tool for the operation and run_tool with that app's connection id " +
    "instead of searching again."
  );
}

/**
 * The connected apps this caller can reach, by label, or none.
 *
 * Read only when a search came back empty, which is the one answer that needs
 * them. Best-effort: a search that found nothing still says so when this read
 * fails, which is all it said before.
 */
async function connectedApps(ctx: ToolContext): Promise<string[]> {
  try {
    const off = await connectionsOffFor(ctx);
    const connections = (await listConnections(ctx.db, ctx.workspaceId, ctx.userId)).filter(
      (c) => !off.has(c.id),
    );
    return connections.filter((c) => c.transport === "composio").map((c) => c.label);
  } catch {
    return [];
  }
}

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

    const { ragBlock, sources, embeddingTokens } = await retrieveForAgent(
      ctx.db,
      ctx.env,
      ctx.agentId,
      query,
      // No history. This is a question the agent asked itself, in its own
      // words, so there is no earlier turn carrying its subject — which is
      // the only thing `retrieveForAgent` reads history for.
      [],
      ctx.knowledgeScope ?? {},
    );

    // The query was embedded to search with, and the route that charged for
    // the turn never saw it — the model chose to search, as many times as it
    // liked. Charged here, the way a connected-service call is.
    await spend(ctx, spends(embeddingSpend(embeddingModel(ctx.env), embeddingTokens, "retrieval")));

    if (!ragBlock.trim()) {
      return { kind: "ok", content: noPassageMatched(await connectedApps(ctx)) };
    }

    // Cited by the reply too, not only named to the model. Deduped the way
    // `retrieveForAgent` dedupes: by id, by name when there is none.
    if (ctx.foundSources) {
      const key = (s: { id: string | null; name: string }) => s.id ?? `name:${s.name}`;
      const seen = new Set(ctx.foundSources.map(key));
      for (const s of sources) {
        if (!s.name || seen.has(key(s))) continue;
        seen.add(key(s));
        ctx.foundSources.push(s);
      }
    }

    const cited = sources.map((s) => s.name).filter(Boolean);
    return {
      kind: "ok",
      content: cited.length > 0 ? `${ragBlock}\n\nFrom: ${cited.join(", ")}` : ragBlock,
    };
  },
};
