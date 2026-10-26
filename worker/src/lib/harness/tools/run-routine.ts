import { runPokedRoutine } from "../../routines/dispatcher";
import type { RoutineRow } from "../../routines/executor";
import { ROUTINE_COLUMNS } from "../../routines/ingest";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * Start another routine now, with something for it to read — one agent
 * handing work to another.
 *
 * **Only the person's own routines.** The id comes from the model, and a
 * routine runs as its owner, delivers to its owner's channel and spends its
 * workspace's credits. So the routine is read with an explicit `user_id`
 * filter as well as whatever the client enforces: in chat the client is the
 * caller's own, and on a scheduled run it is the service role
 * (`capabilitiesFor` says so), where the filter is the only thing standing
 * between an instruction and somebody else's routine.
 *
 * **Only a routine with no source.** The same rule as a webhook
 * (`docs/routines.md`, "Only a routine with no source"): a routine that
 * watches a feed and is poked would either re-fetch on somebody else's
 * schedule or behave differently depending on who started it. What it reads
 * is the `payload` this call hands it.
 *
 * **Asked in chat, not on a schedule.** In a conversation a person sees the
 * card and says yes, as for every tool that acts. A scheduled run has nobody
 * to ask, and routines handing work to each other is the point of the tool
 * there — so it runs, bounded by the two rules above and by depth: each
 * start is one step deeper (`IngestTrigger.depth`), and past
 * `MAX_CHAIN_DEPTH` it is refused, so two routines that start each other stop
 * after a few rounds instead of looping on the workspace's credits.
 *
 * The run is the same road a webhook's takes (`runPokedRoutine`): the
 * membership check, the credit check, claim-before-send and delivery are the
 * executor's. The tool waits for it and hands back its report, which is what
 * makes handing work on useful — the agent that asked can use the answer.
 */

/** How deep a chain of routines starting routines may go. */
export const MAX_CHAIN_DEPTH = 3;

/** The most of the other routine's report handed back to the model. */
const MAX_REPORT_CHARS = 4_000;

/** The most of a payload one routine hands another. */
const MAX_PAYLOAD_CHARS = 20_000;

type Target = RoutineRow & { status: string; source_kind: string; deleted_at: string | null };

export const runRoutineTool: AgentTool = {
  name: "run_routine",
  description:
    "Start one of this person's routines now and wait for its report. Give it the routine's " +
    "id and `payload`, the text it should work from — it reads that in place of a feed. " +
    "Only routines with no source of their own can be started this way. In a conversation " +
    "the person approves it first.",
  input: {
    type: "object",
    properties: {
      routineId: { type: "string", description: "The id of the routine to start." },
      payload: {
        type: "string",
        description: "What the routine should read and work from, written to be read cold.",
      },
    },
    required: ["routineId", "payload"],
    additionalProperties: false,
  },
  destructive: true,
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { routineId?: unknown; payload?: unknown };
    if (typeof input.routineId !== "string" || !input.routineId) {
      return { kind: "error", message: "routineId is required" };
    }
    if (typeof input.payload !== "string" || !input.payload.trim()) {
      return { kind: "error", message: "payload is required" };
    }
    const depth = ctx.chainDepth ?? 0;
    if (depth >= MAX_CHAIN_DEPTH) {
      return {
        kind: "error",
        message:
          `this run was itself started by a chain of ${depth} routines, and starting another ` +
          "could loop; report what you have instead",
      };
    }

    const { data, error } = await ctx.db
      .from("routines")
      .select(ROUTINE_COLUMNS)
      .eq("id", input.routineId)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) {
      if (error.code === "22P02") return { kind: "error", message: "that is not a routine id" };
      return { kind: "error", message: `could not load that routine: ${error.message}` };
    }
    const routine = data as unknown as Target | null;
    if (!routine) return { kind: "error", message: "no such routine belongs to this person" };
    if (routine.status !== "active") {
      return {
        kind: "error",
        message: `that routine is ${routine.status}, so it cannot be started`,
      };
    }
    if (routine.source_kind !== "none") {
      return {
        kind: "error",
        message: "that routine watches a source of its own, so it can only run on its schedule",
      };
    }

    const payload = input.payload.slice(0, MAX_PAYLOAD_CHARS);
    if (!ctx.routineRunId && !ctx.continuation && ctx.confirmed !== true) {
      return {
        kind: "needs_confirmation",
        summary: `Run the routine "${routine.name}" now with what you wrote for it?`,
        proposal: {
          kind: "run_routine",
          routine: { id: routine.id, name: routine.name },
          payload,
        },
      };
    }

    const result = await runPokedRoutine(ctx.env, routine, {
      eventId: `agent:${crypto.randomUUID()}`,
      payload,
      source: "event",
      label: ctx.routineRunId ? "Started by another routine" : "Started from a conversation",
      depth: depth + 1,
    });

    if (result.status === "ok") {
      const report = result.summary ?? "";
      return {
        kind: "ok",
        content:
          `Ran "${routine.name}". It delivered its report to its own channel` +
          (report
            ? `. The report:\n\n${report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n[…cut]` : report}`
            : "."),
      };
    }
    if (result.status === "skipped") {
      return { kind: "ok", content: `Ran "${routine.name}". It found nothing to report.` };
    }
    if (result.status === "waiting") {
      return {
        kind: "ok",
        content: `Started "${routine.name}". It is waiting on a browser and will deliver when that finishes.`,
      };
    }
    return {
      kind: "error",
      message: `"${routine.name}" ran and failed; its run history says why`,
    };
  },
};
