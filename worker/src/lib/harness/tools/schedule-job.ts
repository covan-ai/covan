import { createRoutine } from "../../routines/create";
import { isValidCron, nextRunAt } from "../../routines/schedule";
import { ownHostsFrom } from "../../routines/url-guard";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * Turn "do this every Monday" into a routine — with a person's yes in the
 * middle.
 *
 * **No new kind of object.** What this creates is an ordinary `routines` row:
 * it shows up on the Routines screen, it can be edited, paused and deleted
 * there, and nothing about the engine knows an agent proposed it. No new
 * table, no new `source_kind`, no new migration. That is the whole design
 * decision and it is what keeps the next service from needing one either.
 *
 * `source_kind` is `'none'`, which is also deliberate and is the load-bearing
 * half. The tempting alternative is a source that fetches from the connected
 * service and hands the result to the agent — and that way, every new service
 * needs a new `source_kind` and new fetch code, which is exactly the coupling
 * this whole design exists to avoid. Instead the routine holds the clock and
 * the delivery, and the AGENT fetches, using the same tools it uses in chat.
 *
 * **The agent never creates the row by itself.** It returns
 * `needs_confirmation`; the turn stops; a person sees the proposal and
 * presses a button. Only then does `run` reach the insert, and the insert is
 * `lib/routines/create.ts` — the one `POST /routines` uses, through the
 * caller's own RLS client, so `routines_insert_own` decides exactly as it
 * does for the form.
 */

/** A schedule nobody would ask for, and the shape of a mistake. */
const MIN_CRON_FIELDS = 5;

export const scheduleJobTool: AgentTool = {
  name: "schedule_job",
  description:
    "Propose that something you can do now should happen again on a schedule. The person " +
    "is shown the proposal and has to approve it before anything is created. Describe the " +
    "work in `instruction` exactly as you would want to read it when you run it later, " +
    "including which connections to use — you will have your tools then, but not this " +
    "conversation.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the routine, shown in a list." },
      instruction: {
        type: "string",
        description:
          "What to do each time it runs, written to be read cold. Name the connections and " +
          "what to report.",
      },
      cron: {
        type: "string",
        description: "Five-field cron. 'every Monday at 17:00' is '0 17 * * 1'.",
      },
      timezone: {
        type: "string",
        description: "IANA timezone the cron is read in, e.g. Europe/Istanbul. Defaults to UTC.",
      },
      channelId: {
        type: "string",
        description: "Which of this person's delivery channels the result goes to.",
      },
    },
    required: ["name", "instruction", "cron", "channelId"],
    additionalProperties: false,
  },
  destructive: true,
  needs: "channel",
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as {
      name?: unknown;
      instruction?: unknown;
      cron?: unknown;
      timezone?: unknown;
      channelId?: unknown;
    };
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { kind: "error", message: "name is required" };
    }
    if (typeof input.instruction !== "string" || !input.instruction.trim()) {
      return { kind: "error", message: "instruction is required" };
    }
    if (typeof input.cron !== "string" || input.cron.trim().split(/\s+/).length < MIN_CRON_FIELDS) {
      return { kind: "error", message: "cron must be a five-field cron expression" };
    }
    if (typeof input.channelId !== "string" || !input.channelId) {
      return { kind: "error", message: "channelId is required" };
    }
    const timezone =
      typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : "UTC";
    const cron = input.cron.trim();
    // Checked before a person is asked, not after they say yes. A proposal
    // somebody approves and that then fails validation is the worst order to
    // do this in: they have already made the decision.
    if (!isValidCron(cron, timezone)) {
      return { kind: "error", message: `${cron} in ${timezone} is not a schedule that parses` };
    }

    const { data: channel, error } = await ctx.db
      .from("delivery_channels")
      .select("id, kind, label")
      .eq("id", input.channelId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error) return { kind: "error", message: `could not load that channel: ${error.message}` };
    if (!channel) return { kind: "error", message: "no such channel belongs to this person" };

    const firstRun = nextRunAt(cron, timezone, new Date());
    const proposal = {
      kind: "schedule_job",
      name: input.name.trim(),
      instruction: input.instruction.trim(),
      cron,
      timezone,
      firstRunAt: firstRun.toISOString(),
      channel: { id: channel.id, label: channel.label, kind: channel.kind },
    };

    if (ctx.confirmed !== true) {
      return {
        kind: "needs_confirmation",
        summary:
          `Create a routine "${input.name.trim()}" on ${cron} (${timezone}), delivering to ` +
          `${String(channel.label ?? channel.kind)}?`,
        proposal,
      };
    }

    const created = await createRoutine(
      ctx.db,
      {
        agentId: ctx.agentId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: proposal.name,
        // The routine holds the clock, not a source. See the note at the top
        // of this file for why that is the whole point.
        sourceKind: "none",
        instruction: proposal.instruction,
        deliveryChannelId: String(channel.id),
        scheduleCron: cron,
        timezone,
      },
      ownHostsFrom(ctx.env),
    );
    if (!created.ok) return { kind: "error", message: created.message };

    return {
      kind: "ok",
      content:
        `Created the routine "${proposal.name}". It first runs at ${proposal.firstRunAt} and ` +
        `delivers to ${String(channel.label ?? channel.kind)}. It can be edited or paused on ` +
        `the Routines screen.`,
    };
  },
};
