import {
  TOOLS,
  type AgentTool,
  type ToolContext,
  type ToolResult,
} from "../src/lib/harness/registry";
import type { EvalCase } from "./cases";

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

  return TOOLS.map((tool) => ({
    ...tool,
    // Every tool is offered, whatever the deployment or workspace would say.
    // `capabilitiesFor` filters on live state — connections and channels — and
    // an eval has neither; pinning the list here is what makes two runs
    // comparable rather than dependent on what happened to be connected.
    isConfigured: () => true,
    needs: undefined,
    async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const queue = remaining.get(tool.name);
      const next = queue?.shift();
      const content =
        next ??
        kase.exhausted?.[tool.name] ??
        // No canned answer and no declared fallback: the honest reply is that
        // the tool found nothing, which is also what the real tools say. A
        // throw here would fail the case for a reason that is about the
        // fixture rather than about the model.
        "No result. The tool returned nothing for that call.";
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
