import {
  TOOLS,
  type AgentTool,
  type ToolContext,
  type ToolResult,
} from "../src/lib/harness/registry";
import type { EvalCase } from "./cases";
import { NO_PASSAGE, NO_ROWS } from "./cases";

/**
 * The real tools, with their `run` replaced and nothing else.
 *
 * The name, the description and the JSON Schema come from `TOOLS` untouched,
 * and that is the whole point of building the stubs this way rather than
 * writing six literals: those three fields are *prompt*. They are rendered
 * into every request ahead of the system block, they are what the model reads
 * to decide which tool to reach for, and a Phase 4 change that shortens a tool
 * description is exactly the kind of thing this eval has to be able to see. A
 * hand-written stub would quietly measure a different prompt.
 *
 * What is replaced is only the side effect. `query_database` reaches a
 * customer's database, `send_email` sends mail, `schedule_job` writes a row —
 * none of which an eval may do, and two of which cannot be undone. Replaying
 * canned output also makes the run deterministic in the one dimension that
 * would otherwise swamp the signal: if retrieval returns different passages
 * between two runs, the difference in the answers says nothing about the
 * change being tested.
 */
export function stubbedTools(kase: EvalCase, log: ToolCallLog): AgentTool[] {
  const remaining = new Map<string, string[]>(
    Object.entries(kase.toolResults).map(([name, results]) => [name, [...results]]),
  );
  /** The last canned answer each tool gave, for the idempotent ones below. */
  const last = new Map<string, string>();

  // What this case's agent is offered. Not every tool in the build, which is
  // what this used to do and what the first calibration run caught: the
  // catalogue tools that arrived with #165 were being put in front of cases
  // written before they existed, the model reached for them, the fixture had
  // nothing canned, and it spent steps discovering that. Production never
  // offers that combination — `capabilitiesFor` filters on what the workspace
  // actually has, and a workspace with no catalogue connection gets no
  // `find_tool`. Pinning the set per case restores that filter as a fixture,
  // which is both more faithful and the difference between an 8-step run and
  // a 3-step one on identical input.
  const offered = new Set(kase.tools ?? DEFAULT_TOOLS);

  return TOOLS.filter((tool) => offered.has(tool.name)).map((tool) => ({
    ...tool,
    // `isConfigured` and `needs` answer questions about a deployment and a
    // workspace, and this eval is neither. The set above is the answer to both.
    isConfigured: () => true,
    needs: undefined,
    async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const queue = remaining.get(tool.name);
      const next = queue?.shift();
      const content =
        next ??
        kase.exhausted?.[tool.name] ??
        (IDEMPOTENT.has(tool.name) ? last.get(tool.name) : undefined) ??
        DEFAULT_EXHAUSTED[tool.name] ??
        // Every tool in `DEFAULT_TOOLS` is covered above, so reaching this is a
        // tool added to the build and not to the map. Said plainly rather than
        // dressed as a tool result, because it is a gap in this file.
        `No fixture for ${tool.name}. Add one to DEFAULT_EXHAUSTED in eval/stubs.ts.`;
      if (next !== undefined) last.set(tool.name, next);
      log.push({ tool: tool.name, args, content, replayed: next !== undefined });
      // An `error:` prefix is how `loop.ts` renders a failed tool to the model,
      // so a fixture that starts with it is asking for that path rather than
      // for a successful call whose content happens to mention an error.
      return content.startsWith("error: ")
        ? { kind: "error", message: content.slice("error: ".length) }
        : { kind: "ok", content };
    },
  }));
}

/**
 * The tools a case gets unless it says otherwise.
 *
 * The set a workspace with one connected service and a delivery channel has —
 * which is what every case here was written against, and what production
 * looked like when the turns they are rewrites of actually ran.
 */
export const DEFAULT_TOOLS = [
  "search_documents",
  "describe_connection",
  "query_database",
  "send_email",
  "schedule_job",
];

/**
 * What a tool says once a case has run out of canned answers for it.
 *
 * Every one of these is what the real tool says in that situation, and that is
 * the whole point. The first version of this file had one generic fallback —
 * "No result. The tool returned nothing for that call." — and calibration
 * showed what it cost: a case whose real turn took four steps was canned with
 * three, the fourth call got a sentence no real tool has ever produced, and
 * the model spent the rest of its budget trying to make sense of it. Seven and
 * eight steps on a turn that took four, twice, on identical input.
 *
 * A fixture that runs short should degrade into the ordinary "nothing found",
 * which models handle, rather than into a novel string, which they do not.
 */
const DEFAULT_EXHAUSTED: Record<string, string> = {
  search_documents: NO_PASSAGE,
  query_database: NO_ROWS,
  send_email: "Sent.",
  schedule_job: "Scheduled.",
};

/**
 * Tools whose repeat call returns what the first one did.
 *
 * `describe_connection` caches its summary (`connection.config.summary`) and
 * production hands back the same text every time it is asked without
 * `refresh`. So the faithful exhausted behaviour is not "nothing found", which
 * would tell the model its connection had vanished — it is the summary again.
 */
const IDEMPOTENT = new Set(["describe_connection"]);

export type ToolCallLog = Array<{
  tool: string;
  args: unknown;
  content: string;
  /** False when the case ran out of canned results and got its fallback. */
  replayed: boolean;
}>;

/**
 * A `ToolContext` for tools that never touch it.
 *
 * Every field on the real context exists to be handed to a database or an
 * encrypted secret, and the stubs above ignore all of them. The cast is
 * therefore honest rather than lazy — but it is only honest while the stubs
 * stay stubs, which is why `run` is the single thing they override.
 */
export const NO_CONTEXT = {
  db: null,
  env: {},
  workspaceId: "eval",
  agentId: "eval",
  userId: "eval",
} as unknown as ToolContext;
