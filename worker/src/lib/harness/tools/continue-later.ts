import {
  MAX_WAIT_MINUTES,
  MIN_WAIT_MINUTES,
  scheduleContinuation,
} from "../../continuations/rows";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * End the turn now and be woken later, in this conversation, with a note.
 *
 * The tool that exists because of one afternoon (2026-10-27): an agent asked
 * to make a video started a browser task that sat on the rendering page for
 * ten minutes, billed by the minute for a tab that did nothing. Waiting is
 * not something a browser should do, and it is not something a turn can do
 * either — a turn is a request that ends. So the agent puts the job down:
 * one row (`lib/continuations/rows.ts`), claimed by the cron when its time
 * comes, and run as a new turn in the same conversation with the note as
 * what the agent is told (`lib/continuations/run.ts`).
 *
 * **Not destructive, and no card.** It changes nothing outside Covan. What a
 * woken turn may do is decided where it is done: `browse` runs without a
 * card only where a browser was approved in this conversation before, and a
 * connected app's change goes through on a standing permission or not at
 * all — the rules a scheduled run already lives by.
 *
 * **A routine may set one only while its report is held.** The engine holds
 * a run only while a browser task of the run is unanswered (0100); a timer
 * set with nothing to wait on would wake into a run already sent. So a
 * routine's own turn is refused until it has started a browser task, and a
 * woken turn of a waiting run (`ctx.continuation`) is not.
 *
 * `MAX_NOTE_CHARS` matches the column's check (0142).
 */
const MAX_NOTE_CHARS = 1000;

function wakeClock(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export const continueLaterTool: AgentTool = {
  name: "continue_later",
  description:
    "End this turn now and be woken later in this conversation to carry on. Use it when the " +
    "next thing to do is to wait — a page that is rendering, a job that takes a while — " +
    "instead of waiting inside a browser task, which is billed by the minute. Give minutes " +
    `(${MIN_WAIT_MINUTES} to ${MAX_WAIT_MINUTES}) and a note written to be read cold: what to ` +
    "check and what to do with it. The browser's answers stay in the conversation. When you " +
    "wake, nobody is watching: do what you can without asking, and call continue_later again " +
    "if it is still not time.",
  input: {
    type: "object",
    properties: {
      minutes: {
        type: "integer",
        minimum: MIN_WAIT_MINUTES,
        maximum: MAX_WAIT_MINUTES,
        description: "How long to wait before you are woken, in whole minutes.",
      },
      note: {
        type: "string",
        minLength: 1,
        maxLength: MAX_NOTE_CHARS,
        description:
          "What to do when you wake, written to be read cold: what to check, where, and what " +
          "to do with what you find.",
      },
    },
    required: ["minutes", "note"],
    additionalProperties: false,
  },
  destructive: false,
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { minutes?: unknown; note?: unknown };
    if (
      typeof input.minutes !== "number" ||
      !Number.isInteger(input.minutes) ||
      input.minutes < MIN_WAIT_MINUTES ||
      input.minutes > MAX_WAIT_MINUTES
    ) {
      return {
        kind: "error",
        message: `minutes must be a whole number from ${MIN_WAIT_MINUTES} to ${MAX_WAIT_MINUTES}`,
      };
    }
    const note = typeof input.note === "string" ? input.note.trim().slice(0, MAX_NOTE_CHARS) : "";
    if (!note) {
      return { kind: "error", message: "note is required: say what to do when you wake" };
    }

    const routine = ctx.routineBrowser;
    if (ctx.routineRunId && !ctx.continuation && (routine?.started.length ?? 0) === 0) {
      return {
        kind: "error",
        message:
          "a routine's report is held only while a browser task of its own is running, so " +
          "start the browser task first and then set the time to come back; otherwise finish " +
          "the report now.",
      };
    }

    const sessionId = ctx.sessionId ?? (await routine?.conversation()) ?? null;
    if (!sessionId) {
      return {
        kind: "error",
        message:
          "this run has no conversation to come back to, so it cannot be woken later. A " +
          "routine can be woken only when its owner allows it the browser. Say so and finish.",
      };
    }

    const scheduled = await scheduleContinuation(ctx.env, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      sessionId,
      routineRunId: ctx.routineRunId ?? null,
      minutes: input.minutes,
      note,
    });
    if (scheduled.kind === "refused") return { kind: "error", message: scheduled.message };

    return {
      kind: "ok",
      content:
        `Noted. This turn ends now. You will be woken in ${input.minutes} minutes, at about ` +
        `${wakeClock(scheduled.wakeAt)}, in this conversation with your note, and nobody will ` +
        "be watching then. Tell the person in one line what you will check and when, finish " +
        "your reply, and do not call continue_later again this turn.",
    };
  },
};
